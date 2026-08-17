import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ensureDirWithin, readFileWithin, resolveDirWithin, writeFileWithin } from "../src/hostfs.js";

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

  test("follows a symlink that stays inside the root", async () => {
    writeFileSync(join(root, "real.md"), "inside");
    symlinkSync(join(root, "real.md"), join(root, "link.md"));
    expect(await readFileWithin(root, join(root, "link.md"))).toBe("inside");
  });

  test("refuses a symlink pointing outside the root", async () => {
    const secret = join(outside, "worker.json");
    writeFileSync(secret, "credential");
    symlinkSync(secret, join(root, "workspace", "review.md"));
    expect(readFileWithin(root, join(root, "workspace", "review.md"))).rejects.toThrow(/outside the sandbox root/);
  });

  test("refuses a symlinked parent directory escaping the root", async () => {
    const elsewhere = join(outside, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "review.md"), "secret");
    symlinkSync(elsewhere, join(root, "workspace", ".brevi"));
    expect(readFileWithin(root, join(root, "workspace", ".brevi", "review.md"))).rejects.toThrow(
      /outside the sandbox root/,
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
      /outside the sandbox root/,
    );
  });

  test("overwrites an existing regular file in place", async () => {
    const target = join(root, "brevi-resume.sh");
    writeFileSync(target, "old");
    await writeFileWithin(root, target, "new");
    expect(readFileSync(target, "utf8")).toBe("new");
  });
});

describe("directory containment", () => {
  test("resolveDirWithin refuses a symlinked directory escaping the root", async () => {
    const elsewhere = join(outside, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(root, "workspace", "artifacts"));
    expect(resolveDirWithin(root, join(root, "workspace", "artifacts"))).rejects.toThrow(/outside the sandbox root/);
  });

  test("ensureDirWithin creates and accepts a directory under the root", async () => {
    const dir = await ensureDirWithin(root, join(root, "workspace", "artifacts"));
    expect(dir).toBe(join(root, "workspace", "artifacts"));
  });
});
