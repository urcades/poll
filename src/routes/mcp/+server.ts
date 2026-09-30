import { endSession, handleMcp } from "$lib/server/mcp/server";
import { appRateLimits } from "$lib/server/ratelimit";
import type { RequestHandler } from "./$types";

/**
 * Model Context Protocol endpoint (Streamable HTTP, JSON responses). Agents
 * connect to `<origin>/mcp`; see src/lib/server/mcp/ and the README.
 * Browser cookies are never read here: capabilities live in the MCP session.
 */

const MAX_BODY_BYTES = 1_000_000;

export const POST: RequestHandler = async ({ request, url, getClientAddress }) => {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) return reply(413, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large." } });
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return reply(413, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large." } });

  const { config, limiters } = appRateLimits();
  let ip = "unknown";
  try {
    ip = getClientAddress();
  } catch {
    // No resolvable address: share one bucket rather than skipping limits.
  }
  const authorization = request.headers.get("authorization") ?? "";
  const result = handleMcp(raw, {
    origin: url.origin,
    sessionId: request.headers.get("mcp-session-id"),
    bearer: /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim() ?? "",
    limit: config.enabled ? (bucket) => limiters[bucket].check(ip) : null
  });
  const headers: Record<string, string> = {};
  if (result.sessionId) headers["Mcp-Session-Id"] = result.sessionId;
  return reply(result.status, result.body, headers);
};

/** No server-initiated stream: every response comes back on its POST. */
export const GET: RequestHandler = () => new Response("This MCP server does not offer an SSE stream; POST JSON-RPC messages instead.", {
  status: 405,
  headers: { Allow: "POST, DELETE", "Content-Type": "text/plain; charset=utf-8" }
});

export const DELETE: RequestHandler = ({ request }) => {
  endSession(request.headers.get("mcp-session-id"));
  return new Response(null, { status: 204 });
};

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  if (body === null) return new Response(null, { status, headers: { ...headers, "Cache-Control": "no-store" } });
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
