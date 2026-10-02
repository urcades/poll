import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // Server code reads process.env (as it does in production), which Vite does
  // not fill from .env by itself. Load the TYPESAFE_* settings for dev and
  // preview; variables already in the environment win.
  for (const [key, value] of Object.entries(loadEnv(mode, process.cwd(), "TYPESAFE_"))) {
    process.env[key] ??= value;
  }
  return { plugins: [sveltekit()] };
});
