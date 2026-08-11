import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createGunzip } from "node:zlib";
import { BREVI_HOME, DEFAULT_ROOTFS, type FirecrackerConfig } from "@brevi/shared";
import { execa } from "execa";
import { fileExists } from "../host.js";
import { SSH_KEY_PATH } from "./ssh.js";

/**
 * The rootfs contract version. Bumped whenever the guest contract changes (a new required
 * guest tool, a layout change, a boot-arg contract change, etc.); must match the version
 * packages/sandbox/scripts/build-rootfs.sh writes into rootfs.ext4.manifest.json, and the
 * rootfsVersion published in CI's remote manifest.json for prebuilt images. v2 adds
 * boot-time ssh key injection: the host's public key is passed via a boot arg instead of
 * being baked in, so one prebuilt image can serve every machine.
 *
 * This is compatibility metadata, not the artifact key: prebuilt images are published,
 * downloaded, and cached per @brevi/cli release version, so every release ships (and two
 * installed releases cache) its own image even when the contract did not change.
 */
export const ROOTFS_VERSION = 2;

/** Default remote root prebuilt rootfs images are published under, mirrored by sandbox.firecracker.rootfsBaseUrl. */
export const DEFAULT_ROOTFS_BASE_URL = "https://images.brevi.dev/rootfs";

/** Where downloaded images are cached, one subdirectory per @brevi/cli release version. */
export const ROOTFS_CACHE_DIR = join(BREVI_HOME, "cache", "rootfs");

/** How often installRootfs reports download progress via ensureRootfs's log callback. */
const PROGRESS_LOG_INTERVAL_BYTES = 256 * 1024 * 1024;

/** Cached versions not resolved (used) for this long are pruned after a successful install. */
const PRUNE_UNUSED_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** How long a waiter polls a held install lock before giving up with an error. */
const LOCK_WAIT_TIMEOUT_MS = 15 * 60_000;
const LOCK_POLL_MS = 1_000;
/** A lock whose pid can't be read is considered stale after this long. */
const LOCK_STALE_MS = 60 * 60_000;

const REBUILD_HINT =
  'run "brevi setup" to download the current image, or rebuild from source with packages/sandbox/scripts/build-rootfs.sh';

/** Byte offset of the ext4 superblock magic (0xEF53, little-endian) from the start of the image. */
const EXT4_MAGIC_OFFSET = 1080;
const EXT4_MAGIC_BYTES = Buffer.from([0x53, 0xef]);

/** Maps the host architecture to the directory prebuilt images are published under; undefined when unsupported. */
export function rootfsArch(): "x86_64" | "aarch64" | undefined {
  if (process.arch === "x64") return "x86_64";
  if (process.arch === "arm64") return "aarch64";
  return undefined;
}

/**
 * A version string is used as a single path segment under the cache directory and as a
 * path segment in the download URL, so it must not be able to traverse out of either.
 * The version brevi passes is its own package.json version, never anything a ticket, a
 * repository, or a remote manifest can influence, so this is defense in depth rather
 * than a boundary; it lives here, at the one chokepoint every cache path goes through,
 * so no caller can skip it. Note `..` matches the character class on its own, hence the
 * separate relative-segment check.
 */
function assertCacheableVersion(cliVersion: string): void {
  if (!/^[\w.+-]+$/.test(cliVersion) || cliVersion === "." || cliVersion === "..") {
    throw new Error(`invalid @brevi/cli version for a rootfs cache path: ${JSON.stringify(cliVersion)}`);
  }
}

/** Local cache path for the image belonging to a given @brevi/cli release version. */
export function cachedRootfsPath(cliVersion: string, cacheDir: string = ROOTFS_CACHE_DIR): string {
  assertCacheableVersion(cliVersion);
  return join(cacheDir, cliVersion, "rootfs.ext4");
}

/**
 * The version handshake between a dispatching host and the machine accepting its work.
 * Returns the refusal message when the dispatcher requires a rootfs contract newer than
 * this build supports (the worker is too old to run the work correctly), undefined when
 * compatible. A dispatcher older than this build is fine: a newer worker can always
 * satisfy an older contract's requirements, since contract bumps only add guarantees.
 */
export function rootfsHandshakeProblem(requiredVersion: number): string | undefined {
  if (requiredVersion <= ROOTFS_VERSION) return undefined;
  return `this machine's brevi supports rootfs v${ROOTFS_VERSION}, but the dispatching host requires rootfs v${requiredVersion}: update the worker (run "brevi update" on this machine) before it can accept runs`;
}

export interface RootfsResolution {
  /** Usable rootfs image path; undefined when nothing valid was found. */
  path?: string;
  /** "configured" for a from-source build at sandbox.firecracker.rootfs, "cache" for a downloaded image. */
  source?: "configured" | "cache";
  /** Human-readable reasons no path could be resolved; empty when path is set. */
  problems: string[];
}

/**
 * Validates an existing rootfs file: not empty, looks like ext4, and has a build manifest
 * whose contract version matches this build's ROOTFS_VERSION. Exported so `brevi
 * setup`/`brevi doctor` can distinguish an image that exists but is invalid or outdated
 * from one that is simply missing. Does not verify the full image checksum; locateRootfs
 * does that separately for cached (downloaded) images.
 */
export async function collectRootfsProblems(rootfs: string): Promise<string[]> {
  const problems: string[] = [];

  let size: number;
  try {
    size = (await stat(rootfs)).size;
  } catch {
    problems.push(`rootfs image ${rootfs} is not readable; ${REBUILD_HINT}`);
    return problems;
  }
  if (size === 0) {
    problems.push(`rootfs image ${rootfs} is empty; ${REBUILD_HINT}`);
    return problems;
  }

  if (!(await looksLikeExt4(rootfs))) {
    problems.push(`rootfs image ${rootfs} does not look like a valid ext4 image; ${REBUILD_HINT}`);
  }

  const manifestPath = `${rootfs}.manifest.json`;
  const manifest = await readLocalManifest(manifestPath);
  if (manifest === undefined || typeof manifest.version !== "number") {
    problems.push(
      `rootfs image ${rootfs} has no build manifest (${manifestPath}); it predates the current brevi and may lack required guest tools such as the codex CLI; ${REBUILD_HINT}`,
    );
  } else if (manifest.version < ROOTFS_VERSION) {
    problems.push(
      `rootfs image ${rootfs} was built for an older brevi (rootfs v${manifest.version}, this brevi needs v${ROOTFS_VERSION}); update this machine's image: run "brevi setup" to download the current one, or rebuild from source with packages/sandbox/scripts/build-rootfs.sh`,
    );
  } else if (manifest.version > ROOTFS_VERSION) {
    problems.push(
      `rootfs image ${rootfs} is rootfs v${manifest.version}, newer than this brevi understands (v${ROOTFS_VERSION}); update brevi on this machine (brevi update)`,
    );
  }

  return problems;
}

async function looksLikeExt4(rootfs: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(rootfs, "r");
    const buf = Buffer.alloc(2);
    const { bytesRead } = await handle.read(buf, 0, 2, EXT4_MAGIC_OFFSET);
    return bytesRead === 2 && buf.equals(EXT4_MAGIC_BYTES);
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

interface LocalManifest {
  version: unknown;
  sha256?: unknown;
  builtAt?: unknown;
  source?: unknown;
  cliVersion?: unknown;
}

async function readLocalManifest(manifestPath: string): Promise<LocalManifest | undefined> {
  try {
    const raw = await readFile(manifestPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as LocalManifest;
  } catch {
    return undefined;
  }
}

// Digests are memoized per (path, size, mtime) so repeated preflights in one process hash
// a multi-GB image at most once; a changed size or mtime (redownload, corruption fix) is a
// fresh key and gets rehashed.
const digestCache = new Map<string, Promise<string>>();

async function cachedDigest(path: string): Promise<string> {
  const st = await stat(path);
  const key = `${path}:${st.size}:${st.mtimeMs}`;
  let pending = digestCache.get(key);
  if (pending === undefined) {
    pending = sha256File(path);
    digestCache.set(key, pending);
  }
  return pending;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

/**
 * Full checksum check against the sidecar manifest's sha256, when it has one (downloaded
 * images always record one; a from-source image's sidecar does not, since build-rootfs.sh
 * has no remote digest to compare against). Returns a problem string on mismatch, undefined
 * when there is nothing to check or the digest matches.
 */
async function verifyCachedDigest(path: string): Promise<string | undefined> {
  const manifest = await readLocalManifest(`${path}.manifest.json`);
  const expected = manifest?.sha256;
  if (typeof expected !== "string") return undefined;
  const actual = await cachedDigest(path);
  if (actual === expected) return undefined;
  return `cached rootfs image ${path} failed its checksum (expected ${expected}, got ${actual}); it is likely corrupt, run "brevi setup" to redownload it`;
}

/**
 * Resolves the rootfs image to boot from. A non-empty sandbox.firecracker.rootfs is treated
 * as pinned: only that exact path is checked, the cache is never consulted and never
 * downloaded into (this is the air-gapped / hand-built image path). An empty setting means
 * brevi manages the image and checks, in order: a from-source build at IMAGES_DIR/rootfs.ext4
 * (wins over the cache so a local build is never shadowed), then the downloaded cache for the
 * caller's @brevi/cli release version. A successful cache resolve bumps the version
 * directory's mtime, which is the last-used signal pruning keys on.
 */
export async function locateRootfs(
  config: FirecrackerConfig,
  options: {
    /** The @brevi/cli release version whose cache entry to resolve. */
    cliVersion: string;
    cacheDir?: string;
    /**
     * Overrides where the managed from-source build is looked for. Test-only injection
     * point: it lets tests redirect that check away from the real home directory instead
     * of touching ~/.brevi/images.
     */
    defaultRootfsPath?: string;
  },
): Promise<RootfsResolution> {
  const cacheDir = options.cacheDir ?? ROOTFS_CACHE_DIR;
  const fromSourcePath = options.defaultRootfsPath ?? DEFAULT_ROOTFS;

  // Empty means "wherever brevi puts it" (see resolveFirecrackerImages); anything else is
  // the user's own path and is used verbatim.
  if (config.rootfs !== "") {
    const problems = await collectRootfsProblems(config.rootfs);
    return problems.length === 0
      ? { path: config.rootfs, source: "configured", problems: [] }
      : { problems };
  }

  const problems: string[] = [];

  if (await fileExists(fromSourcePath)) {
    const fromSourceProblems = await collectRootfsProblems(fromSourcePath);
    if (fromSourceProblems.length === 0) {
      return { path: fromSourcePath, source: "configured", problems: [] };
    }
    problems.push(...fromSourceProblems);
  }

  const cachePath = cachedRootfsPath(options.cliVersion, cacheDir);
  const cacheProblems = await collectRootfsProblems(cachePath);
  if (cacheProblems.length === 0) {
    const digestProblem = await verifyCachedDigest(cachePath);
    if (digestProblem === undefined) {
      // Best-effort last-used stamp; pruning never evicts a recently resolved entry.
      await utimes(dirname(cachePath), new Date(), new Date()).catch(() => undefined);
      return { path: cachePath, source: "cache", problems: [] };
    }
    problems.push(digestProblem);
  } else {
    problems.push(...cacheProblems);
  }

  problems.push(
    'no usable rootfs image; run "brevi setup" to download the prebuilt image (or build from source with packages/sandbox/scripts/build-rootfs.sh)',
  );
  return { problems };
}

interface RemoteManifest {
  rootfsVersion: number;
  arch: string;
  builtAt: string;
  cliVersion: string;
  image: { name: string; sha256: string; sizeBytes: number };
  compressed: { name: string; sha256: string; sizeBytes: number };
}

function rootfsUrl(baseUrl: string, cliVersion: string, arch: string, file: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${cliVersion}/${arch}/${file}`;
}

/** https only, except http://127.0.0.1 and http://localhost so tests can serve a local fixture. */
function assertAllowedBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`invalid rootfs base URL: ${baseUrl}`);
  }
  const isLocalHttp = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (url.protocol !== "https:" && !isLocalHttp) {
    throw new Error(
      `rootfs base URL ${baseUrl} must be https (http is only allowed for 127.0.0.1/localhost, for tests)`,
    );
  }
}

/**
 * Validates the remote manifest's shape and that it targets exactly this build: the
 * expected @brevi/cli release (artifacts are published in lockstep with releases, so a
 * manifest for another release must never be installed under this one's cache key), the
 * expected architecture, and this build's rootfs contract version.
 */
function parseRemoteManifest(
  raw: unknown,
  url: string,
  expected: { cliVersion: string; arch: string },
): RemoteManifest {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`rootfs manifest at ${url} has an unexpected shape`);
  }
  const m = raw as Record<string, unknown>;
  const image = m.image;
  const compressed = m.compressed;
  const shapeOk =
    typeof m.rootfsVersion === "number" &&
    typeof m.arch === "string" &&
    typeof m.builtAt === "string" &&
    typeof m.cliVersion === "string" &&
    typeof image === "object" &&
    image !== null &&
    typeof compressed === "object" &&
    compressed !== null &&
    typeof (image as Record<string, unknown>).name === "string" &&
    typeof (image as Record<string, unknown>).sha256 === "string" &&
    typeof (image as Record<string, unknown>).sizeBytes === "number" &&
    typeof (compressed as Record<string, unknown>).name === "string" &&
    typeof (compressed as Record<string, unknown>).sha256 === "string" &&
    typeof (compressed as Record<string, unknown>).sizeBytes === "number";
  if (!shapeOk) {
    throw new Error(`rootfs manifest at ${url} has an unexpected shape`);
  }
  if (m.cliVersion !== expected.cliVersion) {
    throw new Error(
      `rootfs manifest at ${url} is for @brevi/cli ${String(m.cliVersion)}, expected ${expected.cliVersion}`,
    );
  }
  if (m.arch !== expected.arch) {
    throw new Error(`rootfs manifest at ${url} is for ${String(m.arch)}, expected ${expected.arch}`);
  }
  if (m.rootfsVersion !== ROOTFS_VERSION) {
    throw new Error(
      `rootfs manifest at ${url} declares rootfs contract v${String(m.rootfsVersion)}, but this brevi expects v${ROOTFS_VERSION}`,
    );
  }
  return {
    rootfsVersion: m.rootfsVersion as number,
    arch: m.arch as string,
    builtAt: m.builtAt as string,
    cliVersion: m.cliVersion as string,
    image: image as { name: string; sha256: string; sizeBytes: number },
    compressed: compressed as { name: string; sha256: string; sizeBytes: number },
  };
}

async function fetchRemoteManifest(
  url: string,
  expected: { cliVersion: string; arch: string },
): Promise<RemoteManifest> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(`failed to fetch rootfs manifest from ${url}: ${errorMessage(error)}`);
  }
  if (!response.ok) {
    throw new Error(`failed to fetch rootfs manifest from ${url}: HTTP ${response.status}`);
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch (error) {
    throw new Error(`rootfs manifest at ${url} is not valid JSON: ${errorMessage(error)}`);
  }
  return parseRemoteManifest(raw, url, expected);
}

/**
 * Downloads and gunzips the compressed image directly into `destination`, hashing both the
 * compressed bytes (against manifest.compressed.sha256) and the decompressed bytes (against
 * manifest.image.sha256) as they flow, and writing decompressed chunks sparsely (skipping
 * whole-zero chunks, just advancing the position) since the image is mostly zero-filled and
 * a full write would be wasteful on both time and cache disk space.
 */
async function downloadAndVerify(options: {
  url: string;
  destination: string;
  manifest: RemoteManifest;
  onProgress?: (bytes: number, totalBytes?: number) => void;
}): Promise<void> {
  const { url, destination, manifest, onProgress } = options;

  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(`failed to download rootfs image from ${url}: ${errorMessage(error)}`);
  }
  if (!response.ok || response.body === null) {
    throw new Error(`failed to download rootfs image from ${url}: HTTP ${response.status}`);
  }

  const compressedHash = createHash("sha256");
  let compressedBytes = 0;
  const compressedCounter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      compressedHash.update(chunk);
      compressedBytes += chunk.length;
      onProgress?.(compressedBytes, manifest.compressed.sizeBytes);
      callback(null, chunk);
    },
  });

  const decompressedHash = createHash("sha256");
  let decompressedBytes = 0;
  const decompressedCounter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      decompressedHash.update(chunk);
      decompressedBytes += chunk.length;
      callback(null, chunk);
    },
  });

  const handle = await open(destination, "w");
  let position = 0;
  try {
    const sparseWriter = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        const isZero = chunk.every((byte) => byte === 0);
        const written = isZero ? Promise.resolve() : handle.write(chunk, 0, chunk.length, position).then(() => {});
        written.then(
          () => {
            position += chunk.length;
            callback();
          },
          (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
        );
      },
    });

    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      compressedCounter,
      createGunzip(),
      decompressedCounter,
      sparseWriter,
    );

    await handle.truncate(position);
    await handle.sync();
  } finally {
    await handle.close();
  }

  if (compressedBytes !== manifest.compressed.sizeBytes) {
    throw new Error(
      `downloaded rootfs archive size mismatch: expected ${manifest.compressed.sizeBytes} bytes, got ${compressedBytes}`,
    );
  }
  if (decompressedBytes !== manifest.image.sizeBytes) {
    throw new Error(
      `decompressed rootfs image size mismatch: expected ${manifest.image.sizeBytes} bytes, got ${decompressedBytes}`,
    );
  }
  const compressedDigest = compressedHash.digest("hex");
  if (compressedDigest !== manifest.compressed.sha256) {
    throw new Error(
      `downloaded rootfs archive checksum mismatch: expected ${manifest.compressed.sha256}, got ${compressedDigest}`,
    );
  }
  const decompressedDigest = decompressedHash.digest("hex");
  if (decompressedDigest !== manifest.image.sha256) {
    throw new Error(
      `decompressed rootfs image checksum mismatch: expected ${manifest.image.sha256}, got ${decompressedDigest}`,
    );
  }
}

/**
 * Serializes installation of one version across processes via a pid-stamped lock file
 * next to the version directory. A lock whose recorded pid is no longer alive (or that
 * can't be read and is over an hour old) is stolen; a lock held by a live process is
 * polled until released or LOCK_WAIT_TIMEOUT_MS passes. Returns the release function.
 */
async function acquireInstallLock(cacheDir: string, cliVersion: string): Promise<() => Promise<void>> {
  const lockPath = join(cacheDir, `${cliVersion}.lock`);
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(String(process.pid));
      } finally {
        await handle.close();
      }
      return async () => {
        await rm(lockPath, { force: true }).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (await installLockIsStale(lockPath)) {
      await rm(lockPath, { force: true }).catch(() => undefined);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for another brevi process to finish installing the rootfs image (${lockPath} has been held by a live process for over ${LOCK_WAIT_TIMEOUT_MS / 60_000} minutes)`,
      );
    }
    await delay(LOCK_POLL_MS);
  }
}

async function installLockIsStale(lockPath: string): Promise<boolean> {
  try {
    const pid = Number((await readFile(lockPath, "utf8")).trim());
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return false; // The holder is alive.
      } catch (error) {
        // ESRCH: no such process, the holder died. Anything else (EPERM) means a live
        // process we can't signal; treat it as held.
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    }
  } catch {
    // Unreadable (possibly just released); fall through to the age check.
  }
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false; // Gone already; the next open attempt will just succeed.
  }
}

/**
 * Removes cached versions that have not been used recently. Keyed on each version
 * directory's mtime, which locateRootfs bumps on every successful resolve, so an image
 * another installed brevi release still boots from is never evicted just because a newer
 * release was installed; only entries nothing has resolved for 30 days go. The entry just
 * installed is never removed. Best-effort: a failure to remove one entry skips it.
 */
async function pruneOldVersions(cacheDir: string, currentCliVersion: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(cacheDir, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - PRUNE_UNUSED_AFTER_MS;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === currentCliVersion) continue;
    const path = join(cacheDir, entry.name);
    try {
      if ((await stat(path)).mtimeMs < cutoff) {
        await rm(path, { recursive: true, force: true });
      }
    } catch {
      // Raced away or unremovable; leave it for a later install to retry.
    }
  }
}

/**
 * Downloads, verifies, and installs the prebuilt rootfs image for one @brevi/cli release
 * into the cache. Fetches `<baseUrl>/<cliVersion>/<arch>/manifest.json` (validated to
 * target exactly this release, architecture, and rootfs contract), then the compressed
 * image, checked against the manifest's checksums as it streams.
 *
 * Safe under concurrency: installation is serialized per version by a cross-process lock,
 * each installer downloads into its own staging directory, and whatever the version
 * directory held before (stray files, a corrupt image, a dead installer's staging area) is
 * cleared only by the lock holder. A process that finds a valid image already installed
 * once it holds the lock returns it without downloading. Installs atomically: the image is
 * renamed into place before the sidecar manifest, so a crash never leaves a manifest
 * pointing at a half-written image. Throws with a message naming what went wrong on any
 * failure; nothing is left installed.
 */
export async function installRootfs(options: {
  /** The @brevi/cli release version to install the image for; keys the URL and the cache entry. */
  cliVersion: string;
  baseUrl?: string;
  cacheDir?: string;
  onProgress?: (bytes: number, totalBytes?: number) => void;
}): Promise<string> {
  const { cliVersion } = options;
  const cacheDir = options.cacheDir ?? ROOTFS_CACHE_DIR;
  const baseUrl = options.baseUrl ?? DEFAULT_ROOTFS_BASE_URL;

  // Also enforced inside cachedRootfsPath; done here too so the lock file and the download
  // URL, which are built before the first cache-path call, are covered by the same rule.
  assertCacheableVersion(cliVersion);
  const arch = rootfsArch();
  if (arch === undefined) {
    throw new Error(`no prebuilt rootfs image for this host's architecture (${process.arch})`);
  }
  assertAllowedBaseUrl(baseUrl);

  await mkdir(cacheDir, { recursive: true });
  const releaseLock = await acquireInstallLock(cacheDir, cliVersion);
  try {
    const imagePath = cachedRootfsPath(cliVersion, cacheDir);
    const manifestPath = `${imagePath}.manifest.json`;

    // Another process may have completed this install while we waited for the lock.
    if ((await collectRootfsProblems(imagePath)).length === 0 && (await verifyCachedDigest(imagePath)) === undefined) {
      return imagePath;
    }

    // Whatever the version directory holds is missing, stale, or corrupt (including a
    // dead installer's staging leftovers); only the lock holder may clear it.
    const versionDir = join(cacheDir, cliVersion);
    await rm(versionDir, { recursive: true, force: true });

    const manifest = await fetchRemoteManifest(rootfsUrl(baseUrl, cliVersion, arch, "manifest.json"), {
      cliVersion,
      arch,
    });

    const stagingDir = join(versionDir, `.staging-${process.pid}`);
    await mkdir(stagingDir, { recursive: true });
    try {
      const stagedImage = join(stagingDir, "rootfs.ext4");
      const stagedManifest = join(stagingDir, "rootfs.ext4.manifest.json");
      await downloadAndVerify({
        url: rootfsUrl(baseUrl, cliVersion, arch, manifest.compressed.name),
        destination: stagedImage,
        manifest,
        onProgress: options.onProgress,
      });

      const localManifest = {
        version: manifest.rootfsVersion,
        builtAt: manifest.builtAt,
        sha256: manifest.image.sha256,
        source: "download",
        cliVersion: manifest.cliVersion,
      };
      await writeFile(stagedManifest, JSON.stringify(localManifest, null, 2));

      // Image before manifest: a crash between the renames leaves an image without its
      // sidecar (treated as absent), never a manifest pointing at a half-written image.
      await rename(stagedImage, imagePath);
      await rename(stagedManifest, manifestPath);
    } finally {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }

    await pruneOldVersions(cacheDir, cliVersion);
    return imagePath;
  } finally {
    await releaseLock();
  }
}

/**
 * Resolves a usable rootfs, downloading this release's prebuilt image when nothing is
 * found locally. Never throws: a failed download (including a cache cleanup failure, which
 * happens inside the guarded install path) is reported as a problem alongside whatever
 * locateRootfs already found, so callers (provider selection, `brevi doctor`) can decide
 * whether to fall back or fail. Downloading only happens for the default (managed) rootfs
 * path; a custom sandbox.firecracker.rootfs is the caller's responsibility to provision.
 * Does not manage the ssh keypair: callers that boot a VM (createSandboxProvider, `brevi
 * setup`) are responsible for calling ensureSshKeypair themselves before the first boot.
 */
export async function ensureRootfs(
  config: FirecrackerConfig,
  options: {
    /** The @brevi/cli release version whose image to resolve or download. */
    cliVersion: string;
    /** Set false to only resolve locally, e.g. for `brevi doctor` checks that must not download. */
    download?: boolean;
    cacheDir?: string;
    /** See locateRootfs; passed through so tests can avoid the real home directory. */
    defaultRootfsPath?: string;
    log?: (line: string) => void;
    onProgress?: (bytes: number, totalBytes?: number) => void;
  },
): Promise<RootfsResolution & { downloaded?: boolean }> {
  const cacheDir = options.cacheDir ?? ROOTFS_CACHE_DIR;
  const defaultRootfsPath = options.defaultRootfsPath ?? DEFAULT_ROOTFS;
  const log = options.log ?? ((): void => {});

  const resolved = await locateRootfs(config, { cliVersion: options.cliVersion, cacheDir, defaultRootfsPath });
  if (resolved.path !== undefined) return resolved;

  // Only a managed (empty) setting may be downloaded into; a path the user named is theirs.
  const managed = config.rootfs === "";
  if (options.download === false || !managed) return resolved;

  log(
    `rootfs image for brevi ${options.cliVersion} not found locally; downloading from ${config.rootfsBaseUrl}`,
  );

  let loggedMiB = 0;
  try {
    const path = await installRootfs({
      baseUrl: config.rootfsBaseUrl,
      cliVersion: options.cliVersion,
      cacheDir,
      onProgress: (bytes, totalBytes) => {
        options.onProgress?.(bytes, totalBytes);
        const mib = Math.floor(bytes / PROGRESS_LOG_INTERVAL_BYTES);
        if (mib > loggedMiB) {
          loggedMiB = mib;
          const done = Math.round(bytes / (1024 * 1024));
          const total = totalBytes !== undefined ? ` of ${Math.round(totalBytes / (1024 * 1024))} MiB` : "";
          log(`rootfs download: ${done} MiB${total}`);
        }
      },
    });
    return { path, source: "cache", problems: [], downloaded: true };
  } catch (error) {
    return { problems: [...resolved.problems, `rootfs download failed: ${errorMessage(error)}`] };
  }
}

/**
 * Ensures the ssh keypair brevi injects into every microVM at boot (see bootArgs in
 * ./vm.ts) is complete: generates a fresh pair when the private key doesn't exist, and
 * reconstructs a missing public sidecar from an existing private key with `ssh-keygen -y`
 * (installed atomically), since without the sidecar the boot arg is silently omitted and
 * a prebuilt image would accept no key at all. Never overwrites an existing private key:
 * `brevi setup` runs this on hosts that already have a from-source image built with its
 * own baked-in key, and regenerating would break that image's trust. Returns true only
 * when a fresh keypair was generated.
 */
export async function ensureSshKeypair(keyPath: string = SSH_KEY_PATH): Promise<boolean> {
  const pubPath = `${keyPath}.pub`;
  if (await fileExists(keyPath)) {
    if (await fileExists(pubPath)) return false;
    let derived: string;
    try {
      derived = (await execa("ssh-keygen", ["-y", "-P", "", "-f", keyPath])).stdout.trim();
    } catch (error) {
      throw new Error(`failed to reconstruct ${pubPath} from ${keyPath}: ${errorMessage(error)}`);
    }
    const tmpPath = `${pubPath}.tmp`;
    await writeFile(tmpPath, `${derived}\n`, { mode: 0o644 });
    await rename(tmpPath, pubPath);
    return false;
  }
  await mkdir(dirname(keyPath), { recursive: true });
  try {
    await execa("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "brevi-sandbox", "-f", keyPath]);
  } catch (error) {
    throw new Error(`failed to generate ssh keypair at ${keyPath}: ${errorMessage(error)}`);
  }
  return true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
