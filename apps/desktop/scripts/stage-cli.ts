/**
 * Stages a self-contained, resolvable copy of @brevi/cli into
 * apps/desktop/build/cli, for electron-builder to bundle as `extraResources`
 * (see ../electron-builder.yml and src/main/paths.ts's `resolveCliEntry`).
 *
 * Why this exists: packages/cli's build
 * (`bun build ... --external open --external @lydell/node-pty`) produces an
 * ESM entry point with *bare* imports for `open` and `@lydell/node-pty`,
 * relying on a `node_modules` tree next to it to resolve them at runtime
 * (that's what `dependencies` in packages/cli/package.json is for, and what
 * npm/bun set up when the CLI is installed normally). electron-builder's
 * `extraResources` is a plain file copy: it does not run an installer, so
 * copying packages/cli/dist alone leaves those imports unresolved and a
 * packaged app dies with ERR_MODULE_NOT_FOUND before `brevi start` runs a
 * single line. This script builds the missing `node_modules` by resolving
 * the runtime dependency closure from the *workspace's own install* and
 * copying it alongside the copied `dist`.
 *
 * How resolution works: bun installs into a content-addressed store under
 * node_modules/.bun/<name>@<version>+<hash>/node_modules/<name>, with
 * symlinked/hoisted views in each workspace's own node_modules (e.g.
 * packages/cli/node_modules/open). We don't hardcode that layout; instead
 * we replicate the directory walk Node itself uses to resolve a bare
 * specifier (check <dir>/node_modules/<name>, then retry from each parent
 * directory), which finds the right package regardless of where bun's
 * store happens to place it, and dereference the symlink to get the real
 * directory to copy.
 *
 * `@lydell/node-pty` ships a prebuilt, platform-specific native addon
 * selected through per-platform `optionalDependencies` (only the host's
 * package, e.g. `@lydell/node-pty-linux-x64`, is actually installed). That
 * makes the staged tree valid only for the OS/arch it was staged on: the
 * desktop release workflow stages and packages on a matching runner per
 * target (see .github/workflows/desktop-release.yml). An optional
 * dependency that isn't installed on this host is *expected* to be missing
 * and is skipped, not an error.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const CLI_DIR = join(REPO_ROOT, "packages", "cli");
const CLI_DIST = join(CLI_DIR, "dist");
const CLI_ENTRY = join(CLI_DIST, "index.js");
const STAGE_DIR = resolve(HERE, "..", "build", "cli");
const STAGE_DIST = join(STAGE_DIR, "dist");
const NODE_MODULES = join(STAGE_DIR, "node_modules");

interface PackageManifest {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function fail(message: string): never {
  console.error(`✖ ${message}`);
  process.exit(1);
}

function readManifest(dir: string): PackageManifest {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageManifest;
}

/**
 * Node's own module resolution algorithm, minus the parts that don't matter
 * here (no file-extension probing, no `exports` map): from `fromDir`, check
 * `<dir>/node_modules/<name>`, then retry from each ancestor directory until
 * one exists or the filesystem root is reached. Symlinks (bun's hoisted
 * views) are dereferenced to the real directory that holds the package's
 * actual files.
 */
function findPackageDir(name: string, fromDir: string): string | null {
  let dir = resolve(fromDir);
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(candidate)) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function bytesToHuman(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)}${units[unit]}`;
}

function dirSize(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : statSync(full).size;
  }
  return total;
}

// Copied package names, in copy order, for the summary and to de-duplicate
// (by name only: this dependency set is small and shallow enough that we
// don't chase diamond-dependency version conflicts here, we just make sure
// the walk terminates and every name is staged once).
const copied: string[] = [];

function stagePackage(name: string, fromDir: string, required: boolean): void {
  if (copied.includes(name)) return;

  const realDir = findPackageDir(name, fromDir);
  if (!realDir) {
    if (required) {
      fail(
        `Could not resolve dependency "${name}" from the workspace install (looked from ${fromDir}). ` +
          "Run 'bun install' at the repo root first.",
      );
    }
    return; // an optional dependency not installed on this host is expected
  }

  const dest = join(NODE_MODULES, ...name.split("/"));
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(realDir, dest, {
    recursive: true,
    dereference: true,
    // Exclude any node_modules nested *inside* the package's own directory
    // (vendored/bundled deps); this script resolves and flattens the real
    // dependency graph itself, so a nested copy would just be dead weight.
    filter: (src) => {
      const rel = relative(realDir, src);
      return rel === "" || !rel.split(sep).includes("node_modules");
    },
  });

  copied.push(name);

  const manifest = readManifest(realDir);
  for (const dep of Object.keys(manifest.dependencies ?? {})) {
    stagePackage(dep, realDir, true);
  }
  for (const dep of Object.keys(manifest.optionalDependencies ?? {})) {
    stagePackage(dep, realDir, false);
  }
}

// --- 1. Preconditions -------------------------------------------------

if (!existsSync(CLI_ENTRY)) {
  fail(`${CLI_ENTRY} is missing. Run 'bun run build' at the repo root first.`);
}

// --- 2. Wipe and recreate the staging directory, copy dist/ wholesale ---
// The layout mirrors an ordinary production install of the npm package
// (package.json at the root, the bundle under dist/, dependencies under
// node_modules/) rather than inventing a flatter one. That matters beyond
// tidiness: packages/cli/src/lib/version.ts resolves "../package.json"
// relative to the entry file and only trusts a manifest named "@brevi/cli",
// so any other shape silently degrades `brevi --version`, `brevi doctor`
// and the update check to "0.0.0".
//
// Copying dist/ wholesale also carries dist/app (the built dashboard) and
// dist/scripts (the sandbox scripts), both of which the CLI resolves
// relative to its own entry file.

rmSync(STAGE_DIR, { recursive: true, force: true });
mkdirSync(STAGE_DIR, { recursive: true });
cpSync(CLI_DIST, STAGE_DIST, { recursive: true });

// --- 3. Write the staged manifest ---------------------------------------
// Name and version are the real ones so readPackageVersion() finds them.
// "type": "module" is what makes Node parse the `--format=esm` bundle as
// ESM instead of CommonJS. `dependencies` is kept for the record (nothing
// installs from it; step 4 stages those packages directly), and everything
// build-related is dropped: this tree is a runtime artifact, not a checkout.

const cliManifest = readManifest(CLI_DIR) as PackageManifest & { version?: string };
writeFileSync(
  join(STAGE_DIR, "package.json"),
  `${JSON.stringify(
    {
      name: "@brevi/cli",
      version: cliManifest.version ?? "0.0.0",
      private: true,
      type: "module",
      bin: { brevi: "./dist/index.js" },
      dependencies: cliManifest.dependencies ?? {},
    },
    null,
    2,
  )}\n`,
);

// --- 4. Copy the runtime dependency closure into node_modules -----------

mkdirSync(NODE_MODULES, { recursive: true });
for (const name of Object.keys(cliManifest.dependencies ?? {})) {
  stagePackage(name, CLI_DIR, true);
}

// --- 5. Summary -----------------------------------------------------------

const totalBytes = dirSize(STAGE_DIR);
console.log(`Staged @brevi/cli into ${STAGE_DIR}`);
console.log(`  ${copied.length} dependency package(s): ${copied.join(", ")}`);
console.log(`  total size: ${bytesToHuman(totalBytes)}`);
