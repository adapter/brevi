import { lstat, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

/**
 * Path-safety helpers for everything that joins externally influenced names
 * (run ids from HTTP/WS requests, artifact file names persisted from agent
 * output) into filesystem paths under ~/.brevi. Both are containment checks:
 * a hostile value ("../x", an absolute path, a NUL byte) must never make a
 * read or write escape the directory it was scoped to.
 */

/** True when `segment` is usable as one path component under a trusted base directory. */
export function isSafePathSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("/") &&
    !segment.includes("\\") &&
    !segment.includes("\0")
  );
}

/** Resolve `parts` under `baseDir`, or null when the result would escape it. */
export function resolveWithin(baseDir: string, ...parts: string[]): string | null {
  const base = resolve(baseDir);
  const target = resolve(base, ...parts);
  return target === base || target.startsWith(base + sep) ? target : null;
}

/**
 * True when `filePath` is an existing regular file (not a symlink) whose
 * fully resolved location stays under `rootDir`. Guards host-side reads of
 * files pulled out of a sandbox, where any path may be a hostile symlink.
 */
export async function isContainedRegularFile(rootDir: string, filePath: string): Promise<boolean> {
  try {
    const info = await lstat(filePath);
    if (!info.isFile()) return false;
    const root = await realpath(rootDir);
    const real = await realpath(filePath);
    return real.startsWith(root + sep);
  } catch {
    return false;
  }
}
