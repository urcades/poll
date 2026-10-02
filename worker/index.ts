/**
 * Cloudflare entry. The app is one stateful process (SQLite, in-memory rate
 * limits and MCP sessions), so it runs inside a single Durable Object whose
 * SQLite storage holds the database. This Worker only forwards requests to it;
 * static files are served by Workers Assets before the Worker runs.
 */
import { DurableObject } from "cloudflare:workers";
// Built by @sveltejs/adapter-cloudflare (see worker/adapter.wrangler.jsonc).
import sveltekit from "../.svelte-kit/cloudflare/_worker.js";

interface Env {
  APP: DurableObjectNamespace<PollApp>;
}

export class PollApp extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // src/lib/server/app.ts opens the store on this storage.
    (globalThis as { __pollDurableStorage?: unknown }).__pollDurableStorage = ctx.storage;
  }

  fetch(request: Request): Promise<Response> {
    return sveltekit.fetch(request, this.env);
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return env.APP.get(env.APP.idFromName("main")).fetch(request);
  }
} satisfies ExportedHandler<Env>;
