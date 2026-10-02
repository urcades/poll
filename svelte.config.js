import cloudflare from "@sveltejs/adapter-cloudflare";
import node from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

const config = {
  preprocess: vitePreprocess(),
  kit: {
    // ADAPTER=cloudflare builds the Worker (wrangler.jsonc); the default is the Node server.
    adapter: process.env.ADAPTER === "cloudflare" ? cloudflare({ config: "worker/adapter.wrangler.jsonc" }) : node(),
    csp: {
      mode: "auto",
      directives: {
        "default-src": ["self"],
        "script-src": ["self"],
        "style-src": ["self", "unsafe-inline"],
        "img-src": ["self", "data:"],
        "font-src": ["self", "data:"],
        "connect-src": ["self"],
        "frame-ancestors": ["none"],
        "base-uri": ["self"],
        "form-action": ["self"],
        "object-src": ["none"]
      }
    }
  }
};

export default config;
