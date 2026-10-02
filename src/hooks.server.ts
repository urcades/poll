import type { Handle, HandleServerError } from "@sveltejs/kit";
import { runWithContext, sourceForPath } from "./lib/server/context";
import { logEvent } from "./lib/server/events";
import { appRateLimits, enforceRateLimit } from "./lib/server/ratelimit";

/** Random per-browser id set by the page's tracker (lib/track.ts); never a login or a token. */
export const SESSION_COOKIE = "poll_sid";

const { config, limiters } = appRateLimits();

export function applySecurityHeaders(response: Response, isHttps: boolean): Response {
  const defaults: Record<string, string> = {
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
  };
  if (isHttps) defaults["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  for (const [name, value] of Object.entries(defaults)) {
    if (!response.headers.has(name)) response.headers.set(name, value);
  }
  return response;
}

export const handle: Handle = ({ event, resolve }) => {
  const source = sourceForPath(event.url.pathname);
  const raw = source === "mcp" ? (event.request.headers.get("mcp-session-id") ?? "") : (event.cookies.get(SESSION_COOKIE) ?? "");
  const session = /^[A-Za-z0-9_-]{8,64}$/.test(raw) ? raw : "";
  return runWithContext({ source, path: event.url.pathname, session }, () => handleRequest({ event, resolve }));
};

const handleRequest: Handle = async ({ event, resolve }) => {
  const isHttps = event.url.protocol === "https:";
  if (config.enabled) {
    let ip = "unknown";
    try {
      ip = event.getClientAddress();
    } catch {
      // No resolvable address: share one bucket rather than skipping limits.
    }
    const limited = enforceRateLimit(limiters, event.request, event.url.pathname, ip, event.url.search);
    if (limited) {
      logEvent("rate_limited", { method: event.request.method, path: event.url.pathname });
      return applySecurityHeaders(limited, isHttps);
    }
  }
  const response = await resolve(event);
  try {
    return applySecurityHeaders(response, isHttps);
  } catch {
    // Immutable headers (e.g. proxied/redirect responses): copy the response.
    return applySecurityHeaders(
      new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      }),
      isHttps
    );
  }
};

export const handleError: HandleServerError = ({ error, event, status }) => {
  const where = { status, method: event.request.method, path: event.url.pathname };
  if (status === 404) logEvent("not_found", where);
  else logEvent("server_error", { ...where, message: error instanceof Error ? error.message : String(error) });
  console.error(error);
};
