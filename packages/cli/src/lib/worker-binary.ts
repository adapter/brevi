import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { assertAllowedDownloadUrl, downloadToFile } from "./download.js";
import { errorMessage } from "./util.js";

/**
 * Published per @brevi/cli release by .github/workflows/worker-binary.yml,
 * into the same R2 bucket as the prebuilt rootfs images, laid out as
 * `<base>/<cliVersion>/<arch>/{manifest.json,brevi-<arch>.gz}`.
 */
export const WORKER_BINARY_BASE_URL = "https://images.brevi.dev/worker";

const MANIFEST_TIMEOUT_MS = 10_000;

/** Maps the host architecture to the directory worker binaries are published under; undefined when unsupported. */
export function binaryArch(): "x86_64" | "aarch64" | undefined {
  if (process.arch === "x64") return "x86_64";
  if (process.arch === "arm64") return "aarch64";
  return undefined;
}

/**
 * True when this process is a `bun build --compile` standalone executable
 * rather than running through `node`/`bun run` against source or a published
 * npm install. Bun mounts a compiled executable's own entry module inside a
 * virtual filesystem at `/$bunfs/`, and sets `process.argv[1]` to a path
 * under it; that prefix is the one reliable marker for "this process is its
 * own compiled binary", so the check is kept in exactly one place here.
 */
export function isStandaloneBinary(): boolean {
  return process.versions.bun !== undefined && (process.argv[1]?.startsWith("/$bunfs/") ?? false);
}

export interface WorkerBinaryManifest {
  cliVersion: string;
  arch: string;
  binary: { name: string; sha256: string; sizeBytes: number };
  compressed: { name: string; sha256: string; sizeBytes: number };
}

/**
 * Validates the manifest's shape and that it describes exactly the artifact that
 * was asked for. The identity check is not redundant with the URL it came from:
 * a mispublished release directory, or a cache or proxy serving a stale object,
 * hands back a perfectly self-consistent manifest for another release or another
 * architecture, and every checksum below would then verify the wrong binary into
 * place while the updater reported the requested version installed. Mirrors the
 * rootfs manifest's own check (packages/sandbox/src/firecracker/rootfs.ts).
 */
function parseManifest(raw: unknown, url: string, expected: { cliVersion: string; arch: string }): WorkerBinaryManifest {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`worker binary manifest at ${url} has an unexpected shape`);
  }
  const m = raw as Record<string, unknown>;
  const binary = m.binary;
  const compressed = m.compressed;
  const shapeOk =
    typeof m.cliVersion === "string" &&
    typeof m.arch === "string" &&
    typeof binary === "object" &&
    binary !== null &&
    typeof compressed === "object" &&
    compressed !== null &&
    typeof (binary as Record<string, unknown>).name === "string" &&
    typeof (binary as Record<string, unknown>).sha256 === "string" &&
    typeof (binary as Record<string, unknown>).sizeBytes === "number" &&
    typeof (compressed as Record<string, unknown>).name === "string" &&
    typeof (compressed as Record<string, unknown>).sha256 === "string" &&
    typeof (compressed as Record<string, unknown>).sizeBytes === "number";
  if (!shapeOk) {
    throw new Error(`worker binary manifest at ${url} has an unexpected shape`);
  }
  if (m.cliVersion !== expected.cliVersion) {
    throw new Error(
      `worker binary manifest at ${url} is for @brevi/cli ${String(m.cliVersion)}, expected ${expected.cliVersion}`,
    );
  }
  if (m.arch !== expected.arch) {
    throw new Error(`worker binary manifest at ${url} is for ${String(m.arch)}, expected ${expected.arch}`);
  }
  return {
    cliVersion: m.cliVersion as string,
    arch: m.arch as string,
    binary: binary as WorkerBinaryManifest["binary"],
    compressed: compressed as WorkerBinaryManifest["compressed"],
  };
}

/**
 * Fetches and validates `<baseUrl>/<cliVersion>/<arch>/manifest.json`, including
 * that the manifest names this exact release and architecture. A 404 means no
 * binary is published for that pair yet (e.g. a release still building), so it
 * gets a message naming both rather than a bare HTTP status.
 */
export async function fetchWorkerBinaryManifest(
  cliVersion: string,
  arch: string,
  baseUrl: string = WORKER_BINARY_BASE_URL,
): Promise<WorkerBinaryManifest> {
  const url = `${baseUrl.replace(/\/+$/, "")}/${cliVersion}/${arch}/manifest.json`;
  assertAllowedDownloadUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(url, { signal: controller.signal });
    } catch (err) {
      throw new Error(`failed to fetch worker binary manifest from ${url}: ${errorMessage(err)}`);
    }
    if (res.status === 404) {
      throw new Error(`no worker binary is published for @brevi/cli ${cliVersion} (${arch}) at ${url}`);
    }
    if (!res.ok) {
      throw new Error(`failed to fetch worker binary manifest from ${url}: HTTP ${res.status}`);
    }
    let raw: unknown;
    try {
      raw = await res.json();
    } catch (err) {
      throw new Error(`worker binary manifest at ${url} is not valid JSON: ${errorMessage(err)}`);
    }
    return parseManifest(raw, url, { cliVersion, arch });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decompresses `compressedPath` (gzip) into `destPath`, streamed, verifying
 * the decompressed bytes' sha256 as they flow rather than after the fact.
 */
async function gunzipVerify(compressedPath: string, destPath: string, sha256: string): Promise<void> {
  const hash = createHash("sha256");
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(createReadStream(compressedPath), createGunzip(), hashing, createWriteStream(destPath));
  } catch (err) {
    throw new Error(`failed to decompress the worker binary: ${errorMessage(err)}`);
  }
  const actual = hash.digest("hex");
  if (actual !== sha256) {
    throw new Error(`sha256 mismatch for the decompressed worker binary: expected ${sha256}, got ${actual}`);
  }
}

export interface InstallWorkerBinaryOptions {
  /** The @brevi/cli release version whose binary to install; keys the download URL. */
  cliVersion: string;
  /** Path the installed binary should end up at, e.g. the currently running executable's own path. */
  targetPath: string;
  baseUrl?: string;
  onProgress?: (bytes: number) => void;
}

/**
 * Downloads, verifies, and installs the standalone worker binary published
 * for `cliVersion` over `targetPath`. Staging files live next to `targetPath`
 * (never in the system temp directory) so the final rename is a same-
 * filesystem, atomic operation; a cross-device rename would fail outright.
 *
 * Replacing a running executable this way is safe on Linux: `rename` just
 * repoints the directory entry, unlinking the old inode, while a process
 * that already has that inode open (e.g. the worker daemon currently
 * executing out of `targetPath`) keeps running against its own open file
 * description until it exits. Returns the installed path; staging files are
 * removed whether the install succeeds or fails.
 */
export async function installWorkerBinary(options: InstallWorkerBinaryOptions): Promise<string> {
  const { cliVersion, targetPath, baseUrl = WORKER_BINARY_BASE_URL, onProgress } = options;
  const arch = binaryArch();
  if (arch === undefined) {
    throw new Error(`no worker binary is published for this host's architecture (${process.arch})`);
  }

  const manifest = await fetchWorkerBinaryManifest(cliVersion, arch, baseUrl);
  const dir = dirname(targetPath);
  await mkdir(dir, { recursive: true });

  const stem = basename(targetPath);
  const compressedPath = join(dir, `.${stem}.${process.pid}.gz`);
  const stagedPath = join(dir, `.${stem}.${process.pid}.staged`);
  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/${cliVersion}/${arch}/${manifest.compressed.name}`;
    await downloadToFile(url, compressedPath, manifest.compressed.sha256, onProgress);
    await gunzipVerify(compressedPath, stagedPath, manifest.binary.sha256);
    await chmod(stagedPath, 0o755);
    await rename(stagedPath, targetPath);
    return targetPath;
  } finally {
    await rm(compressedPath, { force: true }).catch(() => undefined);
    await rm(stagedPath, { force: true }).catch(() => undefined);
  }
}
