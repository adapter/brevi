import { readFileSync } from "node:fs";

/**
 * Reads the package version from package.json at runtime rather than via a
 * JSON import, so this keeps working regardless of module/import-attribute
 * settings. The bundled build lives at dist/index.js (one level below the
 * package root); the tsc dev build at dist/lib/version.js (two levels).
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
  return "0.0.0";
}
