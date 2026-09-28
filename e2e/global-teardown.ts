import { rmSync } from "node:fs";

export default function globalTeardown() {
  const dir = process.env.E2E_DB_DIR;
  if (dir?.includes("poll-e2e-")) rmSync(dir, { recursive: true, force: true });
}
