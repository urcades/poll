export type Clock = () => number;

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  /** Seconds until the current window resets (>= 1). */
  retryAfter: number;
};

type Entry = { count: number; resetAt: number };

/**
 * Fixed-window in-memory rate limiter. Single-process only. Stale windows are
 * pruned periodically and the table is hard-capped so memory stays bounded.
 */
export class RateLimiter {
  private entries = new Map<string, Entry>();
  private lastPrune: number;

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private now: Clock = Date.now,
    private maxEntries = 10_000
  ) {
    this.lastPrune = now();
  }

  check(key: string): RateLimitResult {
    const now = this.now();
    if (now - this.lastPrune >= this.windowMs) this.prune();

    let entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      if (!entry && this.entries.size >= this.maxEntries) {
        this.prune();
        // Still full of live windows: evict the oldest inserted key.
        if (this.entries.size >= this.maxEntries) {
          const oldest = this.entries.keys().next().value;
          if (oldest !== undefined) this.entries.delete(oldest);
        }
      }
      entry = { count: 0, resetAt: now + this.windowMs };
      this.entries.set(key, entry);
    }

    const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    if (entry.count >= this.limit) return { allowed: false, remaining: 0, retryAfter };
    entry.count++;
    return { allowed: true, remaining: this.limit - entry.count, retryAfter };
  }

  prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
    this.lastPrune = now;
  }

  get size(): number {
    return this.entries.size;
  }
}

export type Bucket = "create" | "mutate";

export type RateLimitConfig = {
  enabled: boolean;
  create: { limit: number; windowMs: number };
  mutate: { limit: number; windowMs: number };
};

function intEnv(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const n = Number.parseInt(env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadRateLimitConfig(env: Record<string, string | undefined>): RateLimitConfig {
  const off = (env.RATE_LIMIT ?? "").trim().toLowerCase();
  return {
    enabled: !["off", "0", "false", "no", "disabled"].includes(off),
    create: {
      limit: intEnv(env, "RATE_LIMIT_CREATE_MAX", 10),
      windowMs: intEnv(env, "RATE_LIMIT_CREATE_WINDOW_SECONDS", 600) * 1000
    },
    mutate: {
      limit: intEnv(env, "RATE_LIMIT_MUTATE_MAX", 60),
      windowMs: intEnv(env, "RATE_LIMIT_MUTATE_WINDOW_SECONDS", 60) * 1000
    }
  };
}

/** Which bucket (if any) a request counts against. */
export function classifyRequest(method: string, pathname: string, search = ""): Bucket | null {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return null;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  // MCP requests are limited per tool call by the MCP handler itself (reads are free, creations use "create").
  if (path === "/mcp") return null;
  if (path === "/api/polls" || path === "/new") return "create";
  // Each description is a paid model call, so it shares the creation budget.
  if (path === "/" && search === "?/suggest") return "create";
  // Duplicating mints a new poll, so it shares the creation budget.
  if (/^\/api\/polls\/[^/]+\/duplicate$/.test(path) || (/^\/poll\/[^/]+$/.test(path) && search === "?/duplicate")) return "create";
  return "mutate";
}

export function wantsJson(request: Request): boolean {
  const accept = request.headers.get("accept") ?? "";
  const type = request.headers.get("content-type") ?? "";
  return accept.includes("application/json") || type.includes("application/json");
}

export function tooManyRequests(request: Request, retryAfter: number): Response {
  const message = "Too many requests. Please slow down and try again shortly.";
  const headers = { "Retry-After": String(retryAfter), "Cache-Control": "no-store" };
  if (wantsJson(request)) {
    return new Response(JSON.stringify({ error: message }), {
      status: 429,
      headers: { ...headers, "Content-Type": "application/json" }
    });
  }
  return new Response(message, {
    status: 429,
    headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" }
  });
}

export function createLimiters(config: RateLimitConfig, now: Clock = Date.now): Record<Bucket, RateLimiter> {
  return {
    create: new RateLimiter(config.create.limit, config.create.windowMs, now),
    mutate: new RateLimiter(config.mutate.limit, config.mutate.windowMs, now)
  };
}

/** Returns a 429 response if the request is over its limit, otherwise null. */
export function enforceRateLimit(
  limiters: Record<Bucket, RateLimiter>,
  request: Request,
  pathname: string,
  clientIp: string,
  search = ""
): Response | null {
  const bucket = classifyRequest(request.method, pathname, search);
  if (!bucket) return null;
  const result = limiters[bucket].check(clientIp);
  return result.allowed ? null : tooManyRequests(request, result.retryAfter);
}

let shared: { config: RateLimitConfig; limiters: Record<Bucket, RateLimiter> } | null = null;

/** The process-wide limiters, shared by the request hook and the MCP handler. */
export function appRateLimits(): { config: RateLimitConfig; limiters: Record<Bucket, RateLimiter> } {
  if (!shared) {
    const config = loadRateLimitConfig(process.env);
    shared = { config, limiters: createLimiters(config) };
  }
  return shared;
}
