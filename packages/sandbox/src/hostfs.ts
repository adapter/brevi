import { constants, createWriteStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdir, open, readdir, readlink, realpath, rm, symlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { isAbsolute, join, relative, sep } from "node:path";

/**
 * Symlink-safe host-side file access for sandbox contents. The agent controls
 * everything under the per-run root, so a host-side read or write that follows
 * a planted symlink would escape the sandbox: reads could exfiltrate worker
 * secrets, writes could truncate host files like ~/.brevi/worker.json.
 *
 * The defense never re-walks a path string unchecked (an attacker can swap a
 * directory for a symlink between a realpath and the open that follows). On
 * Linux it opens the run root as a directory handle and descends one component
 * at a time through /proc/self/fd/<dirfd>/<name> with O_NOFOLLOW, so every
 * component is checked against a real, already-opened parent. On macOS (the
 * Seatbelt provider's platform) the kernel provides the whole property in one
 * flag: O_NOFOLLOW_ANY refuses a symlink in any component of the path,
 * atomically, so the final open itself is the check.
 */

const { O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = constants;

const DARWIN = process.platform === "darwin";
/** macOS-only open(2) flag: fail with ELOOP if any path component is a symlink. */
const O_NOFOLLOW_ANY = 0x20000000;

/**
 * macOS resolution: realpath the host-created root (its ancestors may hold
 * benign symlinks like /var -> /private/var), then open root/parts in one call
 * that refuses agent-planted symlinks anywhere below the root.
 */
async function darwinOpenWithin(
  rootDir: string,
  parts: string[],
  flags: number,
  mode?: number,
): Promise<FileHandle> {
  const real = await realpath(rootDir);
  return open(join(real, ...parts), flags | O_NOFOLLOW_ANY, mode);
}

/** macOS-only open(2) flag: open the symlink itself rather than its target. */
const O_SYMLINK = 0x200000;

/**
 * macOS directory copy out of the sandbox (e.g. pulling the workspace after a
 * run). fs.cp would re-walk pathnames a still-running sandbox process could
 * swap for symlinks mid-copy; instead every file is opened with
 * O_NOFOLLOW_ANY (a racing swap turns into ELOOP, never a host read) and
 * symlink entries are copied verbatim as symlinks, never followed.
 */
export async function copyDirOutOfWithin(rootDir: string, srcDir: string, destDir: string): Promise<void> {
  const parts = relativeParts(rootDir, srcDir, "copy");
  const real = await realpath(rootDir);
  await copyOut(real, parts, destDir);
}

async function copyOut(rootReal: string, parts: string[], destDir: string): Promise<void> {
  const srcPath = join(rootReal, ...parts);
  const dirCheck = await open(srcPath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY);
  await dirCheck.close();
  await mkdir(destDir, { recursive: true });
  for (const entry of await readdir(srcPath, { withFileTypes: true })) {
    const childParts = [...parts, entry.name];
    const childSrc = join(rootReal, ...childParts);
    const childDest = join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyOut(rootReal, childParts, childDest);
    } else if (entry.isSymbolicLink()) {
      // The link's content is copied as a string; nothing ever follows it.
      const target = await readlink(childSrc);
      await rm(childDest, { recursive: true, force: true });
      await symlink(target, childDest);
    } else if (entry.isFile()) {
      // O_NONBLOCK so a regular file swapped for a fifo between readdir and
      // open cannot block this host-side read waiting for a writer that never
      // comes; the fstat below then rejects the non-regular file.
      const src = await open(childSrc, O_RDONLY | O_NOFOLLOW_ANY | O_NONBLOCK);
      try {
        const stats = await src.stat();
        if (!stats.isFile()) continue;
        await rm(childDest, { recursive: true, force: true });
        await pipeline(src.createReadStream(), createWriteStream(childDest, { mode: stats.mode & 0o777 }));
      } finally {
        await src.close();
      }
    }
    // Sockets and fifos are not copied.
  }
}

/**
 * macOS directory copy into the sandbox (checkout push, follow-up .git
 * refresh). Destination files are created through O_NOFOLLOW_ANY opens and
 * every directory level is verified after mkdir, so a swapped component
 * fails the copy instead of redirecting it. A replaced symlink entry is
 * re-verified with O_SYMLINK | O_NOFOLLOW_ANY after creation and removed if
 * the verification fails.
 */
export async function copyDirIntoWithin(rootDir: string, srcDir: string, destDir: string): Promise<void> {
  const parts = relativeParts(rootDir, destDir, "create");
  const real = await realpath(rootDir);
  await darwinDescendDir(rootDir, parts, true);
  await copyInto(real, parts, srcDir);
}

/**
 * Removes a single non-directory entry. Never recursive, and the parent
 * chain is re-verified with O_NOFOLLOW_ANY immediately before the unlink,
 * so an ancestor swapped earlier cannot redirect the deletion; the residual
 * window is one syscall wide and bounded to a single directory entry.
 */
async function unlinkVerified(rootReal: string, parts: string[]): Promise<void> {
  const parent = join(rootReal, ...parts.slice(0, -1));
  const check = await open(parent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY);
  try {
    await rm(join(rootReal, ...parts), { force: false, recursive: false });
  } finally {
    await check.close();
  }
}

async function copyInto(rootReal: string, parts: string[], srcDir: string): Promise<void> {
  for (const entry of await readdir(srcDir, { withFileTypes: true })) {
    const childParts = [...parts, entry.name];
    const destPath = join(rootReal, ...childParts);
    const childSrc = join(srcDir, entry.name);
    if (entry.isDirectory()) {
      const existing = await lstat(destPath).catch(() => undefined);
      if (existing && !existing.isDirectory()) await unlinkVerified(rootReal, childParts);
      try {
        // A swapped ancestor can misdirect this mkdir; the O_NOFOLLOW_ANY
        // verify below then fails the copy, bounding the damage to at most
        // an empty directory (no contents are ever written unverified).
        await mkdir(destPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const check = await open(destPath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY);
      await check.close();
      await copyInto(rootReal, childParts, childSrc);
    } else if (entry.isSymbolicLink()) {
      const target = await readlink(childSrc);
      const existing = await lstat(destPath).catch(() => undefined);
      if (existing?.isDirectory()) {
        throw new Error(`refusing to replace directory ${destPath} with a symlink`);
      }
      if (existing) await unlinkVerified(rootReal, childParts);
      await symlink(target, destPath);
      try {
        const check = await open(destPath, O_RDONLY | O_SYMLINK | O_NOFOLLOW_ANY);
        await check.close();
      } catch (error) {
        await rm(destPath, { force: true, recursive: false });
        throw error;
      }
    } else if (entry.isFile()) {
      const stats = await lstat(childSrc);
      const src = await open(childSrc, O_RDONLY);
      try {
        // O_NOFOLLOW_ANY turns an existing symlink (or a racing swap of any
        // ancestor) into ELOOP; one unlink of that single entry and a retry
        // covers the legitimate overwrite-a-symlink case without ever
        // recursively deleting through a pathname.
        let dest: FileHandle;
        try {
          dest = await open(destPath, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW_ANY, stats.mode & 0o777);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ELOOP") throw error;
          const existing = await lstat(destPath).catch(() => undefined);
          if (existing?.isDirectory()) throw error;
          await unlinkVerified(rootReal, childParts);
          dest = await open(destPath, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW_ANY, stats.mode & 0o777);
        }
        try {
          await pipeline(src.createReadStream(), dest.createWriteStream());
        } finally {
          await dest.close();
        }
      } finally {
        await src.close();
      }
    }
  }
}

/** macOS descent: create/verify each directory level, refusing symlinks at every step. */
async function darwinDescendDir(rootDir: string, parts: string[], create: boolean): Promise<string> {
  const real = await realpath(rootDir);
  let current = real;
  for (const part of parts) {
    current = join(current, part);
    if (create) {
      try {
        await mkdir(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // EEXIST covers a symlink at this component too; the open below rejects it.
      }
    }
    const handle = await open(current, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY);
    await handle.close();
  }
  return join(rootDir, ...parts);
}

/**
 * Reads a regular file, refusing any component that escapes rootDir. With
 * `maxBytes` set, the size of the already-opened descriptor is checked and
 * the read itself is bounded, so neither a swapped nor a still-growing file
 * can read more than the cap into memory.
 */
export async function readFileWithin(rootDir: string, target: string, maxBytes?: number): Promise<string> {
  const parts = relativeParts(rootDir, target, "read");
  if (parts.length === 0) throw new Error(`refusing to read ${target}: it is the sandbox root`);
  if (DARWIN) {
    const handle = await darwinOpenWithin(rootDir, parts, O_RDONLY);
    try {
      return await readOpened(handle, target, maxBytes);
    } finally {
      await handle.close();
    }
  }
  const dir = await openParent(rootDir, parts, false);
  try {
    const handle = await openAt(dir, last(parts), O_RDONLY | O_NOFOLLOW);
    try {
      return await readOpened(handle, target, maxBytes);
    } finally {
      await handle.close();
    }
  } finally {
    await dir.close();
  }
}

/** Reads a verified descriptor to EOF, or to a hard cap when one is given. */
async function readOpened(handle: FileHandle, target: string, maxBytes?: number): Promise<string> {
  const stats = await handle.stat();
  if (!stats.isFile()) throw new Error(`refusing to read ${target}: not a regular file`);
  if (maxBytes === undefined) return handle.readFile("utf8");
  if (stats.size > maxBytes) {
    throw new Error(`refusing to read ${target}: ${stats.size} bytes is over the ${maxBytes}-byte limit`);
  }
  // One spare byte past the descriptor-stat's size detects growth during the
  // read; allocation stays bounded by maxBytes either way.
  const buffer = Buffer.alloc(stats.size + 1);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  if (total > stats.size) {
    throw new Error(`refusing to read ${target}: it grew past ${stats.size} bytes while being read`);
  }
  return buffer.toString("utf8", 0, total);
}

/**
 * Lists a directory's entry names, refusing any component that escapes
 * rootDir. On Linux the listing itself goes through the verified directory
 * handle; on macOS the verified handle is held while the listing re-walks
 * the path, the same one-syscall residual window unlinkVerified accepts.
 */
export async function readdirWithin(rootDir: string, target: string): Promise<string[]> {
  const parts = relativeParts(rootDir, target, "list");
  if (DARWIN) {
    const real = await realpath(rootDir);
    const at = join(real, ...parts);
    const handle = await open(at, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY);
    try {
      return await readdir(at);
    } finally {
      await handle.close();
    }
  }
  let dir = await openRoot(rootDir);
  try {
    for (const part of parts) dir = await step(dir, part, false);
    return await readdir(procPath(dir, "."));
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
  if (DARWIN) {
    await darwinDescendDir(rootDir, parts.slice(0, -1), true);
    const real = await realpath(rootDir);
    const at = join(real, ...parts);
    const existing = await lstat(at).catch(() => undefined);
    // A directory here is a conflict, never a target: a recursive delete at a
    // pathname whose ancestor a racing sandbox process could have swapped is
    // exactly the escape this module exists to prevent, and no write
    // legitimately replaces a directory with a file.
    if (existing?.isDirectory()) {
      throw new Error(`refusing to write ${target}: a directory exists there`);
    }
    // A non-directory (regular file or symlink) is removed with a single
    // non-recursive unlink, its parent chain re-verified through
    // O_NOFOLLOW_ANY immediately before the removal.
    if (existing) await unlinkVerified(real, parts);
    const handle = await open(at, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW_ANY, mode);
    try {
      await handle.writeFile(contents, "utf8");
    } finally {
      await handle.close();
    }
    return;
  }
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
  if (DARWIN) return darwinDescendDir(rootDir, parts, create);
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
