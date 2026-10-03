/**
 * Packages the Worker for `cf deploy --prebuilt`. The cf CLI (beta) can't build
 * SvelteKit projects itself, so: SvelteKit builds with adapter-cloudflare,
 * Wrangler bundles worker/index.ts without deploying, and cf's own library
 * writes that bundle, the static files and the Worker config into the Build
 * Output Specification tree (.cloudflare/output). Run it with Node (`npm run
 * cf:package`); then `cf deploy --prebuilt`.
 */
import { execSync } from "node:child_process";
import { cpSync, readdirSync, rmSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(".");
// The libraries ship inside the globally installed cf CLI.
const cfBin = execSync("command -v cf", { encoding: "utf8" }).trim();
const cfRoot = join(dirname(execSync(`readlink -f ${cfBin}`, { encoding: "utf8" }).trim()), "..");
const load = (name) => import(pathToFileURL(join(cfRoot, "node_modules", name, "dist/index.mjs")).href);
const config = await load("@cloudflare/config");
const output = await load("@cloudflare/build-output-utils");

const run = (command) => execSync(command, { stdio: "inherit" });
const bundleTmp = join(root, ".cloudflare", "bundle-tmp");
run("ADAPTER=cloudflare npx vite build");
rmSync(bundleTmp, { recursive: true, force: true });
run(`npx wrangler deploy --dry-run --outdir ${bundleTmp}`);

const worker = config.defineWorker({
  name: "poll",
  compatibilityDate: "2026-09-01",
  compatibilityFlags: ["nodejs_compat"],
  assets: {},
  exports: { PollApp: config.exports.durableObject({ storage: "sqlite" }) },
  env: {
    APP: config.bindings.durableObject({ worker: "poll", exportName: "PollApp" }),
    ASSETS: config.bindings.assets(),
    // Clef, for describing a vote in words.
    AI: config.bindings.ai()
  },
  observability: { enabled: true }
});
const parsed = config.InputWorkerSchema.parse(worker);

const typeOf = (file) => ({ ".js": "esm", ".mjs": "esm", ".map": "sourcemap", ".wasm": "wasm", ".json": "json", ".txt": "text" })[extname(file)] ?? "data";
const modules = Object.fromEntries(
  readdirSync(bundleTmp, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== "README.md")
    .map((entry) => join(entry.parentPath, entry.name).slice(bundleTmp.length + 1))
    .map((file) => [file, { type: typeOf(file) }])
);

await output.cleanBuildOutputDir(root);
cpSync(bundleTmp, output.getWorkerBundleDir(root), { recursive: true });
rmSync(bundleTmp, { recursive: true, force: true });
await output.writeAssets({ root, sourceDirectory: join(root, ".svelte-kit/cloudflare/assets") });
await output.writeWorkerConfig({ root, config: parsed, manifest: { type: "complete", mainModule: "index.js", modules } });
await output.writeRootConfig(root, undefined, { isPreview: false, mode: "production" });
console.log(`Packaged ${Object.keys(modules).length} modules into .cloudflare/output. Next: cf deploy --prebuilt`);
