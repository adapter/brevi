/**
 * Mirrors the latest released @brevi/cli from registry.npmjs.org to GitHub
 * Packages (npm.pkg.github.com) so it shows up in the repo's Packages
 * sidebar.
 *
 * The mirror is published as @adapter/brevi because GitHub requires an
 * npm package's scope to match the account that owns the repository
 * (adapter); npm's @brevi/cli stays the canonical install source
 * (`npx @brevi/cli`), this copy exists for visibility only.
 *
 * The released tarball is downloaded from npm and re-published with only
 * the package name rewritten — nothing is rebuilt from the checkout, so the
 * mirror can never attach unreleased code to a released version number. And
 * because a staged npm publish is invisible until a maintainer approves it,
 * the mirror naturally trails that approval: CI runs this on every push to
 * main and it is a no-op until a new version is live on npm.
 *
 * Auth: NODE_AUTH_TOKEN must hold a GitHub token with packages:write
 * (the workflow's GITHUB_TOKEN). GITHUB_PACKAGES_REGISTRY and
 * NPM_SOURCE_REGISTRY override the registry URLs for testing against a
 * local registry.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOURCE_REGISTRY =
  process.env.NPM_SOURCE_REGISTRY ?? "https://registry.npmjs.org";
const MIRROR_REGISTRY =
  process.env.GITHUB_PACKAGES_REGISTRY ?? "https://npm.pkg.github.com";

// The CLI is the only published package — keep in sync with stage-publish.ts.
const PACKAGES = [{ source: "@brevi/cli", mirror: "@adapter/brevi" }];

if (!process.env.NODE_AUTH_TOKEN) {
  console.error(
    "✖ NODE_AUTH_TOKEN is not set (needs a GitHub token with packages:write)",
  );
  process.exit(1);
}

const workDir = mkdtempSync(join(tmpdir(), "brevi-gh-packages-"));

// The token stays in the environment: npm expands ${NODE_AUTH_TOKEN} from
// this userconfig at run time, so it is never written to disk.
const npmrc = join(workDir, "npmrc");
writeFileSync(
  npmrc,
  `//${new URL(MIRROR_REGISTRY).host}/:_authToken=\${NODE_AUTH_TOKEN}\n`,
);

const npm = (args: string[], cwd?: string) =>
  execFileSync("npm", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();

let published = 0;
let failed = false;

for (const { source, mirror } of PACKAGES) {
  // Latest version live on npm — staged-but-unapproved versions are not
  // visible here, so only approved releases ever get mirrored.
  let version: string;
  try {
    version = npm(["view", source, "version", "--registry", SOURCE_REGISTRY]);
  } catch {
    console.log(`skip ${source} — nothing released on ${SOURCE_REGISTRY}`);
    continue;
  }

  try {
    npm([
      "view",
      `${mirror}@${version}`,
      "version",
      "--userconfig",
      npmrc,
      "--registry",
      MIRROR_REGISTRY,
    ]);
    console.log(`skip ${source}@${version} — already on GitHub Packages`);
    continue;
  } catch {
    // Version not mirrored; fall through to publish it.
  }

  console.log(
    `mirroring ${source}@${version} → ${mirror} on ${MIRROR_REGISTRY}…`,
  );
  try {
    const tarball = npm([
      "pack",
      `${source}@${version}`,
      "--registry",
      SOURCE_REGISTRY,
      "--pack-destination",
      workDir,
    ]);
    execFileSync("tar", ["-xzf", join(workDir, tarball), "-C", workDir]);

    // Rewrite only the name; everything else ships exactly as released.
    const manifestPath = join(workDir, "package", "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name: string;
    };
    manifest.name = mirror;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    // Publish the re-packed tarball (not the directory) so npm pushes the
    // artifact as-is without running any of the package's own scripts.
    const mirrorTarball = join(workDir, "mirror.tgz");
    // COPYFILE_DISABLE keeps BSD tar (macOS) from adding ._* metadata files.
    execFileSync("tar", ["-czf", mirrorTarball, "-C", workDir, "package"], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    execFileSync(
      "npm",
      [
        "publish",
        mirrorTarball,
        "--userconfig",
        npmrc,
        "--registry",
        MIRROR_REGISTRY,
      ],
      { stdio: "inherit" },
    );
    published += 1;
  } catch (error) {
    console.error(
      `✖ mirroring ${source}@${version} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(
  published > 0
    ? `\n${published} package(s) mirrored to GitHub Packages.`
    : "Nothing to mirror — every released version is already on GitHub Packages.",
);
