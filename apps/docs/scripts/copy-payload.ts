/**
 * Copies the worker installer and its network-setup helper into
 * apps/docs/public/, so they're served as static files at
 * https://brevi.dev/install.sh and https://brevi.dev/setup-network.sh (the
 * one-line `curl | sudo sh` install for a worker machine). The scripts
 * inside packages/worker and packages/sandbox remain the single source of
 * truth; nothing under public/ is checked in.
 *
 * Runs before `astro build` / `astro dev`; the output is gitignored.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PUBLIC_DIR = join(ROOT, "apps/docs/public");

const PAYLOAD = [
  { src: "packages/worker/scripts/install.sh", name: "install.sh" },
  { src: "packages/sandbox/scripts/setup-network.sh", name: "setup-network.sh" },
];

mkdirSync(PUBLIC_DIR, { recursive: true });

for (const { src, name } of PAYLOAD) {
  const from = join(ROOT, src);
  if (!existsSync(from)) {
    console.error(`✖ Missing ${from}. It must exist before the docs build can publish it.`);
    process.exit(1);
  }
  const to = join(PUBLIC_DIR, name);
  copyFileSync(from, to);
  console.log(`installer payload: ${src} -> ${to}`);
}
