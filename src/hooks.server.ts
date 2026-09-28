import type { Handle } from "@sveltejs/kit";
import { createLimiters, enforceRateLimit, loadRateLimitConfig } from "./lib/server/ratelimit";

const config = loadRateLimitConfig(process.env);
const limiters = createLimiters(config);

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

export const handle: Handle = async ({ event, resolve }) => {
  const isHttps = event.url.protocol === "https:";
  if (config.enabled) {
    let ip = "unknown";
    try {
      ip = event.getClientAddress();
    } catch {
      // No resolvable address: share one bucket rather than skipping limits.
    }
    const limited = enforceRateLimit(limiters, event.request, event.url.pathname, ip, event.url.search);
    if (limited) return applySecurityHeaders(limited, isHttps);
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
