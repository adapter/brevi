import { readFileSync } from "node:fs";

/**
 * Reads the package version from package.json at runtime rather than via a
 * JSON import, so this keeps working regardless of module/import-attribute
 * settings. Resolved relative to the compiled dist/ output, one directory
 * above it.
 */
export function readPackageVersion(): string {
  const url = new URL("../../package.json", import.meta.url);
  const raw = readFileSync(url, "utf8");
  const pkg = JSON.parse(raw) as { version?: string };
  return pkg.version ?? "0.0.0";
}
