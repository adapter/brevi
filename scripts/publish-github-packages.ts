/**
 * Mirrors the public workspace packages to GitHub Packages
 * (npm.pkg.github.com) so they show up in the repo's Packages sidebar.
 *
 * registry.npmjs.org stays the canonical install source (`npx @brevi/cli`);
 * this copy exists for visibility only. CI runs this on every push to main
 * after the npm staging step — versions already on GitHub Packages are
 * skipped, so it's a no-op except right after a release. Note the mirror
 * goes live immediately; it does not wait for the npm staged-publish
 * approval.
 *
 * Auth: NODE_AUTH_TOKEN must hold a GitHub token with packages:write
 * (the workflow's GITHUB_TOKEN). GITHUB_PACKAGES_REGISTRY overrides the
 * registry URL for testing against a local registry.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REGISTRY =
  process.env.GITHUB_PACKAGES_REGISTRY ?? "https://npm.pkg.github.com";

// The CLI is the only published package — keep in sync with stage-publish.ts.
const DIRS = ["packages/cli"];

if (!process.env.NODE_AUTH_TOKEN) {
  console.error(
    "✖ NODE_AUTH_TOKEN is not set (needs a GitHub token with packages:write)",
  );
  process.exit(1);
}

// The token stays in the environment: npm expands ${NODE_AUTH_TOKEN} from
// this userconfig at run time, so it is never written to disk.
const npmrc = join(mkdtempSync(join(tmpdir(), "brevi-gh-packages-")), "npmrc");
writeFileSync(
  npmrc,
  `//${new URL(REGISTRY).host}/:_authToken=\${NODE_AUTH_TOKEN}\n`,
);

const npm = (args: string[], cwd?: string) =>
  execFileSync(
    "npm",
    [...args, "--userconfig", npmrc, "--registry", REGISTRY],
    {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).toString();

// On pushes that only open/update the Release PR the publish command never
// ran, so dist may be missing; build lazily before the first real publish.
let built = false;
const ensureBuilt = () => {
  if (built) return;
  execFileSync("bun", ["run", "build"], { stdio: "inherit" });
  built = true;
};

let published = 0;
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
    if (npm(["view", spec, "version"]).trim()) {
      console.log(`skip ${spec} — already on GitHub Packages`);
      continue;
    }
  } catch {
    // Version not mirrored; fall through to publish it.
  }

  console.log(`publishing ${spec} to ${REGISTRY}…`);
  try {
    ensureBuilt();
    execFileSync(
      "npm",
      ["publish", "--userconfig", npmrc, "--registry", REGISTRY],
      {
        cwd: dir,
        stdio: "inherit",
      },
    );
    published += 1;
  } catch {
    console.error(`✖ publishing ${spec} to GitHub Packages failed`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(
  published > 0
    ? `\n${published} package(s) mirrored to GitHub Packages.`
    : "Nothing to mirror — every version is already on GitHub Packages.",
);
