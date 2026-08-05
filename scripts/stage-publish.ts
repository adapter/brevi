/**
 * Stages unpublished package versions with npm staged publishing
 * (https://docs.npmjs.com/staged-publishing).
 *
 * CI runs this after the Release packages PR merges: each public workspace
 * package whose version is missing from the registry is submitted with
 * `npm stage publish` — which needs a token but no OTP — and a maintainer
 * approves with 2FA on npmjs.com (Staged Packages) or via
 * `npm stage approve <stage-id>`.
 *
 * Staging only works for packages that already exist on the registry; the
 * first-ever publish of a package must happen locally: `bun run release:first`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIRS = [
  "packages/shared",
  "packages/sandbox",
  "apps/app",
  "packages/orchestrator",
  "packages/cli",
];

const npm = (args: string[], cwd?: string) =>
  execFileSync("npm", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();

let staged = 0;
let failed = false;

for (const dir of DIRS) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    name: string;
    version: string;
    private?: boolean;
  };
  if (pkg.private) continue;
  const spec = `${pkg.name}@${pkg.version}`;

  try {
    npm(["view", spec, "version"]);
    console.log(`skip ${spec} — already on the registry`);
    continue;
  } catch {
    // Version not published; fall through to stage it.
  }

  try {
    npm(["view", pkg.name, "name"]);
  } catch {
    console.error(`✖ ${pkg.name} has never been published; staging requires an existing package.`);
    console.error("  Run the first publish locally: npm login && bun run release:first");
    failed = true;
    continue;
  }

  console.log(`staging ${spec}…`);
  try {
    execFileSync("npm", ["stage", "publish"], { cwd: dir, stdio: "inherit" });
    staged += 1;
  } catch {
    console.error(`✖ staging ${spec} failed`);
    failed = true;
  }
}

if (failed) process.exit(1);
if (staged > 0) {
  console.log(
    `\n${staged} package(s) staged. Approve them with 2FA on npmjs.com → Staged Packages, or \`npm stage approve <stage-id>\`.`,
  );
} else {
  console.log("Nothing to stage — every version is already on the registry.");
}
