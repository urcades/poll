import { describe, expect, test } from "bun:test";
import {
  RateLimiter,
  classifyRequest,
  createLimiters,
  enforceRateLimit,
  loadRateLimitConfig,
  tooManyRequests
} from "../src/lib/server/ratelimit";
import { applySecurityHeaders } from "../src/hooks.server";

describe("RateLimiter", () => {
  test("allows up to the limit then blocks", () => {
    const t = 0;
    const rl = new RateLimiter(3, 1000, () => t);
    expect([1, 2, 3].map(() => rl.check("a").allowed)).toEqual([true, true, true]);
    const blocked = rl.check("a");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBe(1);
    expect(rl.check("b").allowed).toBe(true);
  });

  test("resets after the window", () => {
    let t = 0;
    const rl = new RateLimiter(1, 1000, () => t);
    expect(rl.check("a").allowed).toBe(true);
    expect(rl.check("a").allowed).toBe(false);
    t = 1000;
    expect(rl.check("a").allowed).toBe(true);
  });

  test("prunes stale entries and caps size", () => {
    let t = 0;
    const rl = new RateLimiter(5, 1000, () => t, 3);
    rl.check("a");
    rl.check("b");
    t = 2000;
    rl.prune();
    expect(rl.size).toBe(0);
    for (const k of ["a", "b", "c", "d", "e"]) rl.check(k);
    expect(rl.size).toBeLessThanOrEqual(3);
  });
});

describe("classification", () => {
  test("buckets", () => {
    expect(classifyRequest("GET", "/api/polls")).toBeNull();
    expect(classifyRequest("HEAD", "/new")).toBeNull();
    expect(classifyRequest("POST", "/api/polls")).toBe("create");
    expect(classifyRequest("POST", "/new")).toBe("create");
    expect(classifyRequest("POST", "/api/polls/abc/votes")).toBe("mutate");
    expect(classifyRequest("POST", "/poll/abc")).toBe("mutate");
    expect(classifyRequest("DELETE", "/api/polls/abc")).toBe("mutate");
  });

  test("config defaults and overrides", () => {
    const d = loadRateLimitConfig({});
    expect(d.enabled).toBe(true);
    expect(d.create).toEqual({ limit: 10, windowMs: 600000 });
    expect(d.mutate).toEqual({ limit: 60, windowMs: 60000 });
    expect(loadRateLimitConfig({ RATE_LIMIT: "off" }).enabled).toBe(false);
    expect(loadRateLimitConfig({ RATE_LIMIT_CREATE_MAX: "2" }).create.limit).toBe(2);
    expect(loadRateLimitConfig({ RATE_LIMIT_CREATE_MAX: "junk" }).create.limit).toBe(10);
  });

  test("enforce uses separate buckets per IP", () => {
    const cfg = loadRateLimitConfig({ RATE_LIMIT_CREATE_MAX: "1", RATE_LIMIT_MUTATE_MAX: "2" });
    const l = createLimiters(cfg, () => 0);
    const post = (p: string) => new Request("http://x" + p, { method: "POST" });
    expect(enforceRateLimit(l, post("/new"), "/new", "1.1.1.1")).toBeNull();
    expect(enforceRateLimit(l, post("/new"), "/new", "1.1.1.1")?.status).toBe(429);
    expect(enforceRateLimit(l, post("/new"), "/new", "2.2.2.2")).toBeNull();
    expect(enforceRateLimit(l, post("/poll/a?/vote"), "/poll/a", "1.1.1.1")).toBeNull();
    expect(enforceRateLimit(l, post("/poll/a?/vote"), "/poll/a", "1.1.1.1")).toBeNull();
    expect(enforceRateLimit(l, post("/poll/a?/vote"), "/poll/a", "1.1.1.1")?.status).toBe(429);
    expect(enforceRateLimit(l, new Request("http://x/"), "/", "1.1.1.1")).toBeNull();
  });
});

describe("429 shape", () => {
  test("json", async () => {
    const res = tooManyRequests(
      new Request("http://x/api/polls", { method: "POST", headers: { "content-type": "application/json" } }),
      42
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(typeof (await res.json()).error).toBe("string");
  });

  test("plain text", async () => {
    const res = tooManyRequests(new Request("http://x/new", { method: "POST" }), 5);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("retry-after")).toBe("5");
    expect((await res.text()).length).toBeGreaterThan(0);
  });
});

describe("security headers", () => {
  test("set, no clobber, HSTS only on https", () => {
    const r = applySecurityHeaders(new Response("x", { headers: { "X-Frame-Options": "SAMEORIGIN" } }), false);
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("strict-transport-security")).toBeNull();
    expect(applySecurityHeaders(new Response("x"), true).headers.get("strict-transport-security")).toBeTruthy();
  });
});
