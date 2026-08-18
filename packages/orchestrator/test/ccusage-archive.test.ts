import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CcusageArchive } from "../src/ccusageArchive.js";

// Run with `bun test packages/orchestrator` from the repo root (after `bun
// run build`, so the `@brevi/shared` import resolves to its dist output).

const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const LINE = '{"type":"assistant","timestamp":"2026-08-11T10:00:20.000Z","message":{"usage":{"input_tokens":5,"output_tokens":9}}}\n';

describe("CcusageArchive", () => {
  let dir: string;
  let archive: CcusageArchive;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "brevi-ccusage-"));
    archive = new CcusageArchive(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("stores a snapshot in the layout ccusage reads through CLAUDE_CONFIG_DIR", async () => {
    await archive.save("claude", "brevi-adapter-brevi", SESSION_ID, LINE);
    const path = join(dir, "claude", "projects", "brevi-adapter-brevi", `${SESSION_ID}.jsonl`);
    expect(readFileSync(path, "utf8")).toBe(LINE);
  });

  it("replaces a session's file wholesale, so a replayed or resumed snapshot cannot double-count", async () => {
    await archive.save("claude", "brevi-a-b", SESSION_ID, LINE);
    const grown = LINE + LINE;
    await archive.save("claude", "brevi-a-b", SESSION_ID, grown);
    const sessionDir = join(dir, "claude", "projects", "brevi-a-b");
    expect(readFileSync(join(sessionDir, `${SESSION_ID}.jsonl`), "utf8")).toBe(grown);
    // Atomic temp+rename semantics: no temp file survives the write.
    expect(readdirSync(sessionDir)).toEqual([`${SESSION_ID}.jsonl`]);
  });

  it("rejects traversal, separators, absolute paths, and hidden names in either segment", async () => {
    const hostile = ["..", ".", "a/b", "a\\b", "a\0b", "", ".hidden", "../../etc"];
    for (const segment of hostile) {
      expect(archive.pathFor("claude", segment, SESSION_ID)).toBeNull();
      expect(archive.pathFor("claude", "brevi-a-b", segment)).toBeNull();
    }
    await expect(archive.save("claude", "..", SESSION_ID, LINE)).rejects.toThrow("unsafe");
    // Nothing was created anywhere under the archive by the refused write.
    expect(existsSync(join(dir, "claude"))).toBe(false);
  });

  it("cleans its temp file up when the write fails, and surfaces the failure", async () => {
    // A directory where the session file belongs makes the rename fail.
    const sessionDir = join(dir, "claude", "projects", "brevi-a-b");
    await archive.save("claude", "brevi-a-b", "other-session", LINE);
    mkdirSync(join(sessionDir, `${SESSION_ID}.jsonl`), { recursive: true });
    await expect(archive.save("claude", "brevi-a-b", SESSION_ID, LINE)).rejects.toThrow();
    expect(readdirSync(sessionDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
