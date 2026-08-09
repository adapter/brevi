import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "bun:test";
import { firecrackerConfigSchema } from "@brevi/shared";
import { execa } from "execa";
import { fileExists } from "../src/host.js";
import { collectSshKeyProblems } from "../src/firecracker/provider.js";
import {
  cachedRootfsPath,
  collectRootfsProblems,
  ensureRootfs,
  ensureSshKeypair,
  installRootfs,
  locateRootfs,
  rootfsArch,
  rootfsHandshakeProblem,
  ROOTFS_VERSION,
} from "../src/firecracker/rootfs.js";
import {
  assertRetainedRootfsCompatible,
  readSandboxRootfsVersion,
  recordSandboxRootfsVersion,
} from "../src/firecracker/vm.js";
import { createSandboxProvider } from "../src/select.js";

// Run with `bun test packages/sandbox` from the repo root (after `bun run build`, so the
// @brevi/shared import resolves to its dist output). Not part of the tsc build: the
// package's tsconfig only includes src/.

const ARCH = rootfsArch();
if (ARCH === undefined) {
  throw new Error("this test host has no supported rootfs architecture (need x64 or arm64)");
}

/** The @brevi/cli release version fixtures in this file pretend to be installing for. */
const CLI_VERSION = "0.5.0";

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** A tiny image with the ext4 magic in place and a real (mostly zero) payload to exercise sparse writing. */
function fakeImage(sizeBytes = 128 * 1024, fillByte = 0xab): Buffer {
  const buf = Buffer.alloc(sizeBytes);
  buf[1080] = 0x53;
  buf[1081] = 0xef;
  buf.fill(fillByte, 20_000, 28_192);
  return buf;
}

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

interface FixtureOptions {
  /** URL path prefix; the cliVersion callers must request installRootfs for. Defaults to CLI_VERSION. */
  urlCliVersion?: string;
  /** cliVersion embedded in the served manifest.json; defaults to urlCliVersion. Diverges only for mismatch tests. */
  manifestCliVersion?: string;
  /** rootfsVersion embedded in the served manifest.json; defaults to ROOTFS_VERSION. Diverges only for mismatch tests. */
  rootfsVersion?: number;
  image: Buffer;
  compressed: Buffer;
  imageSha256?: string;
  compressedSha256?: string;
}

/** Serves <baseUrl>/<cliVersion>/<arch>/{manifest.json,rootfs.ext4.gz} the way CI's publish workflow will. */
async function serveFixture(options: FixtureOptions): Promise<{ url: string; server: Server }> {
  const urlCliVersion = options.urlCliVersion ?? CLI_VERSION;
  const manifest = {
    rootfsVersion: options.rootfsVersion ?? ROOTFS_VERSION,
    arch: ARCH,
    builtAt: "2026-01-01T00:00:00Z",
    cliVersion: options.manifestCliVersion ?? urlCliVersion,
    image: {
      name: "rootfs.ext4",
      sha256: options.imageSha256 ?? sha256(options.image),
      sizeBytes: options.image.length,
    },
    compressed: {
      name: "rootfs.ext4.gz",
      sha256: options.compressedSha256 ?? sha256(options.compressed),
      sizeBytes: options.compressed.length,
    },
  };
  const prefix = `/${urlCliVersion}/${ARCH}/`;

  const server = createServer((req, res) => {
    if (req.url === `${prefix}manifest.json`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(manifest));
      return;
    }
    if (req.url === `${prefix}rootfs.ext4.gz`) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(options.compressed);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, server };
}

describe("installRootfs", () => {
  it("downloads, verifies, and installs atomically", async () => {
    const cacheDir = await tempDir("brevi-rootfs-install-");
    const image = fakeImage();
    const compressed = gzipSync(image);
    const { url, server } = await serveFixture({ image, compressed });
    try {
      const installedPath = await installRootfs({ baseUrl: url, cliVersion: CLI_VERSION, cacheDir });
      expect(installedPath).toBe(cachedRootfsPath(CLI_VERSION, cacheDir));

      const installed = await readFile(installedPath);
      expect(installed.equals(image)).toBe(true);

      const manifest = JSON.parse(await readFile(`${installedPath}.manifest.json`, "utf8")) as {
        version: number;
        sha256: string;
        cliVersion: string;
      };
      expect(manifest.version).toBe(ROOTFS_VERSION);
      expect(manifest.sha256).toBe(sha256(image));
      expect(manifest.cliVersion).toBe(CLI_VERSION);

      const versionDirEntries = await readdir(join(cacheDir, CLI_VERSION));
      expect(versionDirEntries.some((name) => name.startsWith(".staging-"))).toBe(false);
      expect((await readdir(cacheDir)).some((name) => name.endsWith(".lock"))).toBe(false);
    } finally {
      server.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("rejects a wrong compressed checksum and installs nothing", async () => {
    const cacheDir = await tempDir("brevi-rootfs-badgz-");
    const image = fakeImage();
    const compressed = gzipSync(image);
    const { url, server } = await serveFixture({
      image,
      compressed,
      compressedSha256: "0".repeat(64),
    });
    try {
      await expect(installRootfs({ baseUrl: url, cliVersion: CLI_VERSION, cacheDir })).rejects.toThrow(/checksum/i);
      expect(await fileExists(cachedRootfsPath(CLI_VERSION, cacheDir))).toBe(false);
    } finally {
      server.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("rejects a wrong image checksum and installs nothing", async () => {
    const cacheDir = await tempDir("brevi-rootfs-badimg-");
    const image = fakeImage();
    const compressed = gzipSync(image);
    const { url, server } = await serveFixture({
      image,
      compressed,
      imageSha256: "0".repeat(64),
    });
    try {
      await expect(installRootfs({ baseUrl: url, cliVersion: CLI_VERSION, cacheDir })).rejects.toThrow(/checksum/i);
      expect(await fileExists(cachedRootfsPath(CLI_VERSION, cacheDir))).toBe(false);
    } finally {
      server.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("rejects a remote manifest for a different @brevi/cli release and installs nothing", async () => {
    const cacheDir = await tempDir("brevi-rootfs-wrongcli-");
    const image = fakeImage();
    const compressed = gzipSync(image);
    const { url, server } = await serveFixture({
      image,
      compressed,
      // Served under the requested version's URL prefix, but the manifest body claims a
      // different release; installRootfs must catch this instead of trusting the path.
      manifestCliVersion: "9.9.9",
    });
    try {
      await expect(installRootfs({ baseUrl: url, cliVersion: CLI_VERSION, cacheDir })).rejects.toThrow(
        /expected 0\.5\.0|@brevi\/cli/i,
      );
      expect(await fileExists(cachedRootfsPath(CLI_VERSION, cacheDir))).toBe(false);
      expect(await fileExists(join(cacheDir, CLI_VERSION))).toBe(false);
    } finally {
      server.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("rejects a remote manifest declaring a different rootfs contract version and installs nothing", async () => {
    const cacheDir = await tempDir("brevi-rootfs-wrongcontract-");
    const image = fakeImage();
    const compressed = gzipSync(image);
    const { url, server } = await serveFixture({
      image,
      compressed,
      rootfsVersion: ROOTFS_VERSION + 1,
    });
    try {
      await expect(installRootfs({ baseUrl: url, cliVersion: CLI_VERSION, cacheDir })).rejects.toThrow();
      expect(await fileExists(cachedRootfsPath(CLI_VERSION, cacheDir))).toBe(false);
    } finally {
      server.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("caches two @brevi/cli releases side by side without either evicting the other", async () => {
    const cacheDir = await tempDir("brevi-rootfs-coexist-");
    const imageA = fakeImage(128 * 1024, 0xaa);
    const compressedA = gzipSync(imageA);
    const imageB = fakeImage(128 * 1024, 0xbb);
    const compressedB = gzipSync(imageB);
    const fixtureA = await serveFixture({ urlCliVersion: "0.5.0", image: imageA, compressed: compressedA });
    const fixtureB = await serveFixture({ urlCliVersion: "0.6.0", image: imageB, compressed: compressedB });
    try {
      await installRootfs({ baseUrl: fixtureA.url, cliVersion: "0.5.0", cacheDir });
      // Installing the newer release must not evict the older one, which was just used
      // (created) and is well within the prune window.
      await installRootfs({ baseUrl: fixtureB.url, cliVersion: "0.6.0", cacheDir });

      const pathA = cachedRootfsPath("0.5.0", cacheDir);
      const pathB = cachedRootfsPath("0.6.0", cacheDir);
      expect((await readFile(pathA)).equals(imageA)).toBe(true);
      expect((await readFile(pathB)).equals(imageB)).toBe(true);
      expect(await collectRootfsProblems(pathA)).toEqual([]);
      expect(await collectRootfsProblems(pathB)).toEqual([]);
    } finally {
      fixtureA.server.close();
      fixtureB.server.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("prunes only cached versions unused for over 30 days, sparing recently used nonadjacent versions", async () => {
    const cacheDir = await tempDir("brevi-rootfs-prune-");
    try {
      await mkdir(join(cacheDir, "0.1.0"), { recursive: true });
      await writeFile(join(cacheDir, "0.1.0", "rootfs.ext4"), "stub");
      const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
      await utimes(join(cacheDir, "0.1.0"), fortyDaysAgo, fortyDaysAgo);

      await mkdir(join(cacheDir, "0.3.0"), { recursive: true });
      await writeFile(join(cacheDir, "0.3.0", "rootfs.ext4"), "stub");
      const now = new Date();
      await utimes(join(cacheDir, "0.3.0"), now, now);

      const image = fakeImage();
      const compressed = gzipSync(image);
      const { url, server } = await serveFixture({ urlCliVersion: "0.7.0", image, compressed });
      try {
        await installRootfs({ baseUrl: url, cliVersion: "0.7.0", cacheDir });
        expect((await readdir(cacheDir)).sort()).toEqual(["0.3.0", "0.7.0"]);
      } finally {
        server.close();
      }
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent installs of the same version to one consistent result", async () => {
    const cacheDir = await tempDir("brevi-rootfs-concurrent-");
    const image = fakeImage();
    const compressed = gzipSync(image);
    const { url, server } = await serveFixture({ image, compressed });
    try {
      const [pathA, pathB] = await Promise.all([
        installRootfs({ baseUrl: url, cliVersion: CLI_VERSION, cacheDir }),
        installRootfs({ baseUrl: url, cliVersion: CLI_VERSION, cacheDir }),
      ]);
      expect(pathA).toBe(pathB);
      expect(pathA).toBe(cachedRootfsPath(CLI_VERSION, cacheDir));

      const installed = await readFile(pathA);
      expect(installed.equals(image)).toBe(true);

      const manifest = JSON.parse(await readFile(`${pathA}.manifest.json`, "utf8")) as {
        version: number;
        sha256: string;
      };
      expect(manifest.version).toBe(ROOTFS_VERSION);
      expect(manifest.sha256).toBe(sha256(image));

      const versionEntries = await readdir(join(cacheDir, CLI_VERSION));
      expect(versionEntries.some((name) => name.startsWith(".staging-"))).toBe(false);
      const cacheEntries = await readdir(cacheDir);
      expect(cacheEntries.some((name) => name.endsWith(".lock"))).toBe(false);
    } finally {
      server.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});

describe("locateRootfs / ensureRootfs against the cache", () => {
  it("detects a corrupted cached image via checksum, then ensureRootfs redownloads it", async () => {
    const cacheDir = await tempDir("brevi-rootfs-corrupt-");
    // A throwaway "default path" outside the cache dir, standing in for the real
    // ~/.brevi/images/rootfs.ext4 so this test never touches the real home directory. It
    // stays nonexistent throughout: only the cache is populated.
    const defaultDir = await tempDir("brevi-rootfs-corrupt-default-");
    const defaultRootfsPath = join(defaultDir, "rootfs.ext4");
    const image = fakeImage();
    const compressed = gzipSync(image);
    const { url, server } = await serveFixture({ image, compressed });
    try {
      await installRootfs({ baseUrl: url, cliVersion: CLI_VERSION, cacheDir });
      const imagePath = cachedRootfsPath(CLI_VERSION, cacheDir);

      // Corrupt one byte in the middle, preserving size and the ext4 magic. Bump mtime so
      // the digest memoization (keyed on path:size:mtimeMs) can't serve a stale, pre
      // -corruption digest for the same key.
      const bytes = await readFile(imagePath);
      bytes[Math.floor(bytes.length / 2)] ^= 0xff;
      await writeFile(imagePath, bytes);
      await utimes(imagePath, new Date(), new Date());

      // Empty rootfs is the managed setting: the from-source path, then the cache.
      const config = firecrackerConfigSchema.parse({ rootfs: "", rootfsBaseUrl: url });
      const located = await locateRootfs(config, { cliVersion: CLI_VERSION, cacheDir, defaultRootfsPath });
      expect(located.path).toBeUndefined();
      expect(located.problems.some((problem) => problem.includes("checksum"))).toBe(true);

      const ensured = await ensureRootfs(config, {
        cliVersion: CLI_VERSION,
        download: true,
        cacheDir,
        defaultRootfsPath,
        log: () => {},
      });
      expect(ensured.downloaded).toBe(true);
      expect(ensured.path).toBe(imagePath);
      expect(ensured.problems).toEqual([]);

      expect((await readFile(imagePath)).equals(image)).toBe(true);
    } finally {
      server.close();
      await rm(cacheDir, { recursive: true, force: true });
      await rm(defaultDir, { recursive: true, force: true });
    }
  });
});

describe("collectRootfsProblems version handshake", () => {
  it("flags an image built for an older brevi as needing an update to this machine's image", async () => {
    const dir = await tempDir("brevi-rootfs-old-");
    try {
      const rootfsPath = join(dir, "rootfs.ext4");
      await writeFile(rootfsPath, fakeImage());
      await writeFile(`${rootfsPath}.manifest.json`, JSON.stringify({ version: 1 }));
      const problems = await collectRootfsProblems(rootfsPath);
      expect(problems.some((problem) => problem.includes("update this machine's image"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("flags an image newer than this brevi understands as needing a brevi update", async () => {
    const dir = await tempDir("brevi-rootfs-new-");
    try {
      const rootfsPath = join(dir, "rootfs.ext4");
      await writeFile(rootfsPath, fakeImage());
      await writeFile(`${rootfsPath}.manifest.json`, JSON.stringify({ version: 99 }));
      const problems = await collectRootfsProblems(rootfsPath);
      expect(problems.some((problem) => problem.includes("update brevi"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("locateRootfs source preference", () => {
  it("prefers a valid image at the default path over the cache", async () => {
    const cacheDir = await tempDir("brevi-rootfs-pref-cache-");
    // A throwaway "default path" standing in for ~/.brevi/images/rootfs.ext4, via
    // locateRootfs's defaultRootfsPath override, so this test never touches the real
    // home directory.
    const defaultDir = await tempDir("brevi-rootfs-pref-default-");
    const defaultRootfsPath = join(defaultDir, "rootfs.ext4");
    try {
      await writeFile(defaultRootfsPath, fakeImage());
      await writeFile(`${defaultRootfsPath}.manifest.json`, JSON.stringify({ version: ROOTFS_VERSION }));

      // A valid cache image too, so a wrong pick is observable via `source`.
      const cacheImagePath = cachedRootfsPath(CLI_VERSION, cacheDir);
      await mkdir(dirname(cacheImagePath), { recursive: true });
      await writeFile(cacheImagePath, fakeImage());
      await writeFile(`${cacheImagePath}.manifest.json`, JSON.stringify({ version: ROOTFS_VERSION }));

      const config = firecrackerConfigSchema.parse({ rootfs: "" });
      const resolved = await locateRootfs(config, { cliVersion: CLI_VERSION, cacheDir, defaultRootfsPath });
      expect(resolved.source).toBe("configured");
      expect(resolved.path).toBe(defaultRootfsPath);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
      await rm(defaultDir, { recursive: true, force: true });
    }
  });

  it("never falls back to the cache for a custom (non-empty) rootfs path", async () => {
    const cacheDir = await tempDir("brevi-rootfs-custom-cache-");
    const customDir = await tempDir("brevi-rootfs-custom-path-");
    try {
      const cacheImagePath = cachedRootfsPath(CLI_VERSION, cacheDir);
      await mkdir(dirname(cacheImagePath), { recursive: true });
      await writeFile(cacheImagePath, fakeImage());
      await writeFile(`${cacheImagePath}.manifest.json`, JSON.stringify({ version: ROOTFS_VERSION }));

      const customPath = join(customDir, "rootfs.ext4");
      const config = firecrackerConfigSchema.parse({ rootfs: customPath });
      const resolved = await locateRootfs(config, { cliVersion: CLI_VERSION, cacheDir });
      expect(resolved.path).toBeUndefined();
      expect(resolved.problems.length).toBeGreaterThan(0);
      expect(resolved.problems.some((problem) => problem.includes(cacheDir))).toBe(false);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
      await rm(customDir, { recursive: true, force: true });
    }
  });
});

describe("rootfsHandshakeProblem", () => {
  it("is satisfied by this build's own version and anything older", () => {
    expect(rootfsHandshakeProblem(ROOTFS_VERSION)).toBeUndefined();
    expect(rootfsHandshakeProblem(ROOTFS_VERSION - 1)).toBeUndefined();
  });

  it("refuses a contract newer than this build supports", () => {
    const problem = rootfsHandshakeProblem(ROOTFS_VERSION + 1);
    expect(problem).toBeDefined();
    expect(problem).toContain("update the worker");
  });
});

describe("createSandboxProvider rootfs version handshake", () => {
  it("refuses an explicit firecracker request when the dispatcher requires a newer contract", async () => {
    await expect(
      createSandboxProvider({
        requested: "firecracker",
        firecracker: firecrackerConfigSchema.parse({}),
        cliVersion: CLI_VERSION,
        requiredRootfsVersion: ROOTFS_VERSION + 1,
      }),
    ).rejects.toThrow(/update the worker/);
  });

  it("refuses auto selection too, rather than silently downgrading to the process provider", async () => {
    await expect(
      createSandboxProvider({
        requested: "auto",
        firecracker: firecrackerConfigSchema.parse({}),
        cliVersion: CLI_VERSION,
        requiredRootfsVersion: ROOTFS_VERSION + 1,
      }),
    ).rejects.toThrow(/update the worker/);
  });
});

describe("retained sandbox disk rootfs markers (vm.ts)", () => {
  it("recordSandboxRootfsVersion / readSandboxRootfsVersion round-trip the current contract version", async () => {
    const dir = await tempDir("brevi-rootfs-marker-");
    try {
      await recordSandboxRootfsVersion(dir);
      expect(await readSandboxRootfsVersion(dir)).toBe(ROOTFS_VERSION);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("readSandboxRootfsVersion returns undefined when nothing was recorded", async () => {
    const dir = await tempDir("brevi-rootfs-marker-empty-");
    try {
      expect(await readSandboxRootfsVersion(dir)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("assertRetainedRootfsCompatible enforces the version handshake for retained disks", () => {
    const path = "/tmp/does-not-matter/rootfs.ext4";
    expect(() => assertRetainedRootfsCompatible(path, undefined)).toThrow(/older brevi/);
    expect(() => assertRetainedRootfsCompatible(path, ROOTFS_VERSION - 1)).toThrow(/cannot be resumed/);
    expect(() => assertRetainedRootfsCompatible(path, ROOTFS_VERSION + 1)).toThrow(/update brevi/);
    expect(() => assertRetainedRootfsCompatible(path, ROOTFS_VERSION)).not.toThrow();
  });
});

const hasSshKeygen = Bun.which("ssh-keygen") !== null;
const maybeIt = hasSshKeygen ? it : it.skip;

describe("ssh keypair (vm.ts / provider.ts)", () => {
  maybeIt("generates a fresh keypair, reconstructs a missing .pub, and validates the pair", async () => {
    const dir = await tempDir("brevi-ssh-keypair-");
    const otherDir = await tempDir("brevi-ssh-keypair-other-");
    try {
      const keyPath = join(dir, "id_ed25519");
      const pubPath = `${keyPath}.pub`;

      const generated = await ensureSshKeypair(keyPath);
      expect(generated).toBe(true);
      expect(await fileExists(keyPath)).toBe(true);
      expect(await fileExists(pubPath)).toBe(true);

      await rm(pubPath, { force: true });
      const reconstructed = await ensureSshKeypair(keyPath);
      expect(reconstructed).toBe(false);
      expect(await fileExists(pubPath)).toBe(true);

      const expectedPub = (await execa("ssh-keygen", ["-y", "-P", "", "-f", keyPath])).stdout.trim();
      const writtenPub = (await readFile(pubPath, "utf8")).trim();
      const fields = (key: string): string[] => key.trim().split(/\s+/).slice(0, 2);
      expect(fields(writtenPub)).toEqual(fields(expectedPub));

      expect(await collectSshKeyProblems(keyPath)).toEqual([]);

      // Overwrite the .pub with a different keypair's public half: the mismatch must be caught.
      const otherKeyPath = join(otherDir, "id_ed25519");
      await ensureSshKeypair(otherKeyPath);
      const otherPub = await readFile(`${otherKeyPath}.pub`, "utf8");
      await writeFile(pubPath, otherPub);
      const mismatchProblems = await collectSshKeyProblems(keyPath);
      expect(mismatchProblems.length).toBeGreaterThan(0);
      expect(mismatchProblems.some((problem) => problem.includes("does not match"))).toBe(true);

      // Remove the .pub entirely: reported as a missing public key.
      await rm(pubPath, { force: true });
      const missingProblems = await collectSshKeyProblems(keyPath);
      expect(missingProblems.length).toBeGreaterThan(0);
      expect(missingProblems.some((problem) => problem.includes("public key"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(otherDir, { recursive: true, force: true });
    }
  });
});
