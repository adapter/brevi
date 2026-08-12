import { readFileSync } from "node:fs";

/**
 * Reads the package version from package.json at runtime rather than via a
 * JSON import, so this keeps working regardless of module/import-attribute
 * settings. The bundled build lives at dist/index.js (one level below the
 * package root); the tsc dev build at dist/lib/version.js (two levels).
 *
 * The standalone single-file executable (`bun run build:binary`) has no
 * package.json on disk at all, so it cannot use either candidate below.
 * Instead, packages/cli/scripts/build-binary.ts replaces the
 * `process.env.BREVI_EMBEDDED_CLI_VERSION` expression with a string literal
 * at compile time via `bun build`'s `--define`, baking the version in. That
 * baked-in value is only consulted after both candidates have failed, which
 * is exactly the situation the binary is in: an npm install always has a
 * package.json to read, so no environment variable can talk it into
 * misreporting its version (which is also the rootfs image cache key).
 */
export function readPackageVersion(): string {
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      const raw = readFileSync(new URL(rel, import.meta.url), "utf8");
      const pkg = JSON.parse(raw) as { name?: string; version?: string };
      if (pkg.name === "@brevi/cli" && pkg.version) return pkg.version;
    } catch {
      // Try the next candidate.
    }
  }
  return process.env.BREVI_EMBEDDED_CLI_VERSION || "0.0.0";
}
