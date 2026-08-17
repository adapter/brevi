import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";

/**
 * Symlink-safe host-side file access for sandbox contents. The agent controls
 * everything under the per-run root, so a host-side read or write that follows
 * a planted symlink would escape the sandbox: reads could exfiltrate worker
 * secrets, writes could truncate host files like ~/.brevi/worker.json. Every
 * path is resolved with realpath and must stay under the run root, and final
 * components are opened with O_NOFOLLOW.
 */

/** Reads a regular file, refusing any path that resolves outside rootDir. */
export async function readFileWithin(rootDir: string, target: string): Promise<string> {
  const root = await realpath(rootDir);
  const real = await realpath(target);
  assertWithin(root, real, target, "read");
  const stats = await lstat(real);
  if (!stats.isFile()) {
    throw new Error(`refusing to read ${target}: not a regular file`);
  }
  const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Writes a regular file, refusing any parent that resolves outside rootDir.
 * An existing symlink or directory at the target is removed, never followed.
 */
export async function writeFileWithin(
  rootDir: string,
  target: string,
  contents: string,
  mode = 0o644,
): Promise<void> {
  const root = await realpath(rootDir);
  await mkdir(dirname(target), { recursive: true });
  const parent = await realpath(dirname(target));
  assertWithin(root, parent, target, "write");
  const dest = join(parent, basename(target));
  const existing = await lstat(dest).catch(() => undefined);
  if (existing && !existing.isFile()) await rm(dest, { recursive: true, force: true });
  const handle = await open(
    dest,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    mode,
  );
  try {
    await handle.writeFile(contents, "utf8");
  } finally {
    await handle.close();
  }
}

/** Resolves an existing directory, refusing one outside rootDir. */
export async function resolveDirWithin(rootDir: string, target: string): Promise<string> {
  const root = await realpath(rootDir);
  const real = await realpath(target);
  assertWithin(root, real, target, "copy");
  return real;
}

/** Creates (if needed) and resolves a directory, refusing one outside rootDir. */
export async function ensureDirWithin(rootDir: string, target: string): Promise<string> {
  await mkdir(target, { recursive: true });
  return resolveDirWithin(rootDir, target);
}

function assertWithin(root: string, real: string, target: string, action: string): void {
  if (real === root || real.startsWith(root + sep)) return;
  throw new Error(`refusing to ${action} ${target}: it resolves outside the sandbox root ${root}`);
}
