import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 4319);
const ORIGIN = `http://127.0.0.1:${PORT}`;

// One fresh database per run, never work/votes.sqlite. The config is evaluated
// by the runner before the web server starts and again in every worker; the env
// var pins the same directory for all of them. globalTeardown removes it.
process.env.E2E_DB_DIR ??= mkdtempSync(join(tmpdir(), "poll-e2e-"));

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.e2e\.ts/,
  globalTeardown: "./e2e/global-teardown.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: ORIGIN,
    trace: "retain-on-failure",
    acceptDownloads: true
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, testIgnore: /mobile\.e2e\.ts/ },
    { name: "mobile", use: { ...devices["Pixel 7"], viewport: { width: 375, height: 812 } }, testMatch: /mobile\.e2e\.ts/ }
  ],
  // Production build on purpose: it is what enforces the strict CSP.
  // E2E_TARGET=worker runs the same suite against the Cloudflare Worker
  // (Durable Object + SQLite) in wrangler's local runtime.
  webServer: {
    command:
      process.env.E2E_TARGET === "worker"
        ? `bun run build:cloudflare && wrangler dev --local --ip 127.0.0.1 --port ${PORT} --persist-to ${process.env.E2E_DB_DIR} --var RATE_LIMIT:off`
        : "bun run build && node build/index.js",
    url: `${ORIGIN}/`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      HOST: "127.0.0.1",
      PORT: String(PORT),
      ORIGIN,
      RATE_LIMIT: "off",
      DB_PATH: join(process.env.E2E_DB_DIR, "votes.sqlite")
    }
  }
});
