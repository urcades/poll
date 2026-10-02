import { AsyncLocalStorage } from "node:async_hooks";

/** What every logged event learns about the request it happened in. */
export interface RequestContext {
  /** "web" pages and form actions, "api" JSON routes, "mcp" agent tools, "internal" anything else (tests, scripts). */
  source: "web" | "api" | "mcp" | "internal";
  path: string;
  /** The browser tab's random id (from the poll_sid cookie), or the MCP session id. Empty if unknown. */
  session: string;
  /** Set by the MCP dispatcher while a tool runs. */
  tool?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentContext(): RequestContext {
  return storage.getStore() ?? { source: "internal", path: "", session: "" };
}

export function sourceForPath(pathname: string): RequestContext["source"] {
  if (pathname === "/mcp") return "mcp";
  if (pathname.startsWith("/api/")) return "api";
  return "web";
}
