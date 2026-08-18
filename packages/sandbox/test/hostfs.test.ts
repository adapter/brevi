import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  copyDirIntoWithin,
  copyDirOutOfWithin,
  ensureDirWithin,
  readFileWithin,
  resolveDirWithin,
  writeFileWithin,
} from "../src/hostfs.js";

let outside: string;
let root: string;

beforeEach(() => {
  outside = mkdtempSync(join(tmpdir(), "brevi-hostfs-"));
  root = join(outside, "run-1");
  mkdirSync(join(root, "workspace"), { recursive: true });
});

afterEach(() => {
  rmSync(outside, { recursive: true, force: true });
});

describe("readFileWithin", () => {
  test("reads a regular file under the root", async () => {
    const target = join(root, "workspace", ".brevi", "review.md");
    mkdirSync(join(root, "workspace", ".brevi"), { recursive: true });
    writeFileSync(target, "looks good");
    expect(await readFileWithin(root, target)).toBe("looks good");
  });

  test("refuses a symlink target even when it stays inside the root", async () => {
    // The control files we read (review.md, summary.md) are never symlinks;
    // refusing them outright removes a whole class of reasoning.
    writeFileSync(join(root, "real.md"), "inside");
    symlinkSync(join(root, "real.md"), join(root, "link.md"));
    expect(readFileWithin(root, join(root, "link.md"))).rejects.toThrow(/ELOOP|not a regular file/);
  });

  test("refuses a symlink pointing outside the root", async () => {
    const secret = join(outside, "worker.json");
    writeFileSync(secret, "credential");
    symlinkSync(secret, join(root, "workspace", "review.md"));
    expect(readFileWithin(root, join(root, "workspace", "review.md"))).rejects.toThrow(
      /ELOOP|not a regular file/,
    );
  });

  test("refuses a symlinked parent directory escaping the root", async () => {
    const elsewhere = join(outside, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "review.md"), "secret");
    symlinkSync(elsewhere, join(root, "workspace", ".brevi"));
    expect(readFileWithin(root, join(root, "workspace", ".brevi", "review.md"))).rejects.toThrow(
      /not a regular file|ENOTDIR|ELOOP/,
    );
  });

  test("refuses an intermediate symlink even when it points back inside the root", async () => {
    // The final target is in-root, but a middle component is a symlink. A
    // string realpath of just the parent would miss this; descending with
    // O_NOFOLLOW does not.
    const real = join(root, "real-dir");
    mkdirSync(real);
    writeFileSync(join(real, "file"), "inside");
    symlinkSync(real, join(root, "workspace", "link-dir"));
    expect(readFileWithin(root, join(root, "workspace", "link-dir", "file"))).rejects.toThrow(
      /ENOTDIR|ELOOP/,
    );
  });
});

describe("writeFileWithin", () => {
  test("writes a regular file and creates parents", async () => {
    const target = join(root, "codex-home", "auth.json");
    await writeFileWithin(root, target, "{}");
    expect(readFileSync(target, "utf8")).toBe("{}");
  });

  test("replaces a planted symlink instead of writing through it", async () => {
    const victim = join(outside, "config.json");
    writeFileSync(victim, "precious");
    symlinkSync(victim, join(root, "brevi-credentials.sh"));
    await writeFileWithin(root, join(root, "brevi-credentials.sh"), "export TOKEN=x");
    expect(readFileSync(victim, "utf8")).toBe("precious");
    expect(lstatSync(join(root, "brevi-credentials.sh")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(root, "brevi-credentials.sh"), "utf8")).toBe("export TOKEN=x");
  });

  test("refuses a symlinked parent directory escaping the root", async () => {
    const elsewhere = join(outside, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(root, "codex-home"));
    expect(writeFileWithin(root, join(root, "codex-home", "auth.json"), "{}")).rejects.toThrow(
      /ENOTDIR|ELOOP|EEXIST/,
    );
    // The write must not have created the file through the symlink.
    expect(lstatSync(join(elsewhere, "auth.json"), { throwIfNoEntry: false })).toBeUndefined();
  });

  test("does not create directories outside the root when a parent is a symlink", async () => {
    // Regression: mkdir(recursive) ran before the containment check and could
    // materialize host dirs through a planted symlink (e.g. ~/.brevi/.git).
    const elsewhere = join(outside, "victim");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(root, "workspace-link"));
    expect(writeFileWithin(root, join(root, "workspace-link", ".git", "config"), "x")).rejects.toThrow();
    expect(lstatSync(join(elsewhere, ".git"), { throwIfNoEntry: false })).toBeUndefined();
  });

  test("overwrites an existing regular file in place", async () => {
    const target = join(root, "brevi-resume.sh");
    writeFileSync(target, "old");
    await writeFileWithin(root, target, "new");
    expect(readFileSync(target, "utf8")).toBe("new");
  });

  test("refuses to write where a directory already exists", async () => {
    mkdirSync(join(root, "conflict"));
    expect(writeFileWithin(root, join(root, "conflict"), "x")).rejects.toThrow();
  });
});

describe("directory containment", () => {
  test("resolveDirWithin refuses a symlinked directory escaping the root", async () => {
    const elsewhere = join(outside, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(root, "workspace", "artifacts"));
    expect(resolveDirWithin(root, join(root, "workspace", "artifacts"))).rejects.toThrow(/ENOTDIR|ELOOP/);
  });

  test("ensureDirWithin does not create through a symlinked component", async () => {
    const elsewhere = join(outside, "victim");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(root, "linked"));
    expect(ensureDirWithin(root, join(root, "linked", "nested"))).rejects.toThrow();
    expect(lstatSync(join(elsewhere, "nested"), { throwIfNoEntry: false })).toBeUndefined();
  });

  test("ensureDirWithin creates and accepts a directory under the root", async () => {
    const dir = await ensureDirWithin(root, join(root, "workspace", "artifacts"));
    expect(dir).toBe(join(root, "workspace", "artifacts"));
  });
});

describe.if(process.platform === "darwin")("directory copies on macOS", () => {
  test("round-trips a tree, copying symlink entries verbatim", async () => {
    const src = join(outside, "src");
    mkdirSync(join(src, "nested"), { recursive: true });
    writeFileSync(join(src, "a.txt"), "alpha");
    writeFileSync(join(src, "nested", "b.txt"), "beta");
    symlinkSync("/etc/hosts", join(src, "link"));

    await copyDirIntoWithin(root, src, join(root, "workspace", "in"));
    expect(readFileSync(join(root, "workspace", "in", "a.txt"), "utf8")).toBe("alpha");
    expect(readFileSync(join(root, "workspace", "in", "nested", "b.txt"), "utf8")).toBe("beta");
    expect(lstatSync(join(root, "workspace", "in", "link")).isSymbolicLink()).toBe(true);

    const out = join(outside, "out");
    await copyDirOutOfWithin(root, join(root, "workspace", "in"), out);
    expect(readFileSync(join(out, "nested", "b.txt"), "utf8")).toBe("beta");
    expect(lstatSync(join(out, "link")).isSymbolicLink()).toBe(true);
  });

  test("push refuses a symlinked destination component", async () => {
    const src = join(outside, "src2");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "a.txt"), "alpha");
    const elsewhere = join(outside, "victim2");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(root, "escape"));
    expect(copyDirIntoWithin(root, src, join(root, "escape", "in"))).rejects.toThrow();
    expect(lstatSync(join(elsewhere, "in"), { throwIfNoEntry: false })).toBeUndefined();
  });

  test("pull refuses to read file contents through a symlink", async () => {
    const dir = join(root, "workspace", "leak");
    mkdirSync(dir, { recursive: true });
    symlinkSync("/etc/hosts", join(dir, "hosts"));
    const out = join(outside, "out2");
    await copyDirOutOfWithin(root, dir, out);
    // Copied as a symlink, not as the contents of /etc/hosts.
    expect(lstatSync(join(out, "hosts")).isSymbolicLink()).toBe(true);
  });
});
