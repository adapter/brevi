import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

/**
 * Symlink-safe host-side file access for sandbox contents. The agent controls
 * everything under the per-run root, so a host-side read or write that follows
 * a planted symlink would escape the sandbox: reads could exfiltrate worker
 * secrets, writes could truncate host files like ~/.brevi/worker.json.
 *
 * The defense never re-walks a path string (an attacker can swap a directory
 * for a symlink between a realpath and the open that follows). Instead it opens
 * the run root as a directory handle and descends one component at a time
 * through /proc/self/fd/<dirfd>/<name> with O_NOFOLLOW, so every intermediate
 * and final component is checked against a real, already-opened parent. Linux
 * only, which is the sole platform bwrap runs on.
 */

const { O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC, O_DIRECTORY, O_NOFOLLOW } = constants;

/** Reads a regular file, refusing any component that escapes rootDir. */
export async function readFileWithin(rootDir: string, target: string): Promise<string> {
  const parts = relativeParts(rootDir, target, "read");
  if (parts.length === 0) throw new Error(`refusing to read ${target}: it is the sandbox root`);
  const dir = await openParent(rootDir, parts, false);
  try {
    const handle = await openAt(dir, last(parts), O_RDONLY | O_NOFOLLOW);
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) throw new Error(`refusing to read ${target}: not a regular file`);
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } finally {
    await dir.close();
  }
}

/**
 * Writes a regular file, refusing any component that escapes rootDir. An
 * existing symlink or directory at the target is removed, never followed.
 */
export async function writeFileWithin(
  rootDir: string,
  target: string,
  contents: string,
  mode = 0o644,
): Promise<void> {
  const parts = relativeParts(rootDir, target, "write");
  if (parts.length === 0) throw new Error(`refusing to write ${target}: it is the sandbox root`);
  const dir = await openParent(rootDir, parts, true);
  try {
    const at = procPath(dir, last(parts));
    const existing = await lstatType(at);
    if (existing === "other") await rm(at, { recursive: true, force: true });
    const handle = await open(at, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, mode);
    try {
      await handle.writeFile(contents, "utf8");
    } finally {
      await handle.close();
    }
  } finally {
    await dir.close();
  }
}

/** Resolves an existing directory, refusing one reached through a symlink. */
export async function resolveDirWithin(rootDir: string, target: string): Promise<string> {
  return descendDir(rootDir, target, false, "copy");
}

/** Creates (descending without following symlinks) and resolves a directory. */
export async function ensureDirWithin(rootDir: string, target: string): Promise<string> {
  return descendDir(rootDir, target, true, "create");
}

/**
 * Opens every component as a directory (creating each when create is set),
 * then returns the canonical path of the deepest one. Because the whole chain
 * was verified through O_NOFOLLOW handles, that realpath cannot have traversed
 * a symlink out of the root.
 */
async function descendDir(rootDir: string, target: string, create: boolean, action: string): Promise<string> {
  const parts = relativeParts(rootDir, target, action);
  let dir = await openRoot(rootDir);
  try {
    for (const part of parts) dir = await step(dir, part, create);
    return await realpath(procPath(dir, "."));
  } finally {
    await dir.close();
  }
}

/** Opens the directory that should contain the final component of parts. */
async function openParent(rootDir: string, parts: string[], create: boolean): Promise<FileHandle> {
  let dir = await openRoot(rootDir);
  try {
    for (const part of parts.slice(0, -1)) dir = await step(dir, part, create);
    return dir;
  } catch (error) {
    await dir.close();
    throw error;
  }
}

/** Descends one directory level, creating it first when create is set. */
async function step(dir: FileHandle, part: string, create: boolean): Promise<FileHandle> {
  if (create) {
    try {
      await mkdir(procPath(dir, part));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        await dir.close();
        throw error;
      }
      // EEXIST for a symlinked component means mkdir refused to follow it; the
      // O_NOFOLLOW open below then rejects it. A real directory just opens.
    }
  }
  try {
    const next = await openAt(dir, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    await dir.close();
    return next;
  } catch (error) {
    await dir.close();
    throw error;
  }
}

async function openRoot(rootDir: string): Promise<FileHandle> {
  // realpath is safe here: the run root and its ancestors are host-created,
  // not agent-writable. Everything below it is descended with O_NOFOLLOW.
  return open(await realpath(rootDir), O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
}

function openAt(dir: FileHandle, name: string, flags: number): Promise<FileHandle> {
  return open(procPath(dir, name), flags);
}

function procPath(dir: FileHandle, name: string): string {
  return `/proc/self/fd/${dir.fd}/${name}`;
}

async function lstatType(path: string): Promise<"file" | "missing" | "other"> {
  try {
    return (await lstat(path)).isFile() ? "file" : "other";
  } catch {
    return "missing";
  }
}

function last(parts: string[]): string {
  return parts[parts.length - 1] as string;
}

/**
 * The components of target relative to rootDir, rejecting anything that escapes
 * the root lexically. Callers pass a target already normalized by resolve(), so
 * a rel that starts with ".." can only mean an out-of-root path.
 */
function relativeParts(rootDir: string, target: string, action: string): string[] {
  if (target === rootDir) return [];
  const rel = relative(rootDir, target);
  if (rel === "" || rel === ".") return [];
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`refusing to ${action} ${target}: it resolves outside the sandbox root ${rootDir}`);
  }
  return rel.split(sep).filter((part) => part !== "" && part !== ".");
}
