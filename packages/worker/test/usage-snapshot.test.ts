import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectUsageSnapshots, minimizeClaudeSessionJsonl, projectKeyFor } from "../src/usageSnapshot.js";

// Run with `bun test packages/worker` from the repo root (after `bun run
// build`, so the `@brevi/shared` import resolves to its dist output). Tests
// are excluded from the tsc build (tsconfig includes src only).

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

/** A transcript line carrying everything private a snapshot must strip, alongside the usage it must keep. */
const assistantLine = JSON.stringify({
  parentUuid: "aaaa",
  uuid: "bbbb",
  cwd: "/home/brevi/.brevi/workspaces/run-1/workspace",
  sessionId: SESSION_ID,
  version: "2.0.44",
  gitBranch: "main",
  type: "assistant",
  timestamp: "2026-08-11T10:00:20.000Z",
  requestId: "req_1",
  message: {
    id: "msg_1",
    model: "claude-sonnet-5",
    role: "assistant",
    content: [
      { type: "thinking", thinking: "secret reasoning" },
      { type: "text", text: "the response text" },
      { type: "tool_use", id: "tool_1", name: "Bash", input: { command: "cat /etc/passwd" } },
    ],
    usage: {
      input_tokens: 12,
      output_tokens: 34,
      cache_creation_input_tokens: 56,
      cache_read_input_tokens: 78,
      service_tier: "standard",
    },
  },
});

const promptLine = JSON.stringify({
  type: "user",
  timestamp: "2026-08-11T10:00:10.000Z",
  sessionId: SESSION_ID,
  message: { role: "user", content: "the secret prompt, with an API key sk-ant-xxxx" },
});

describe("projectKeyFor", () => {
  it("reduces a repo key to one safe path segment and never leaks a filesystem path", () => {
    expect(projectKeyFor("adapterlabs/brevi")).toBe("brevi-adapterlabs-brevi");
    expect(projectKeyFor("../../etc")).toBe("brevi-etc");
    expect(projectKeyFor(undefined)).toBe("brevi-unknown");
    expect(projectKeyFor("///")).toBe("brevi-unknown");
  });
});

describe("minimizeClaudeSessionJsonl", () => {
  it("keeps only usage accounting fields and drops prompt, response, thinking, tool, and path content", () => {
    const { jsonl, kept } = minimizeClaudeSessionJsonl(`${promptLine}\n${assistantLine}\n`, SESSION_ID);
    expect(kept).toBe(1);
    const line = JSON.parse(jsonl.trim()) as Record<string, unknown>;
    expect(line).toEqual({
      type: "assistant",
      timestamp: "2026-08-11T10:00:20.000Z",
      sessionId: SESSION_ID,
      requestId: "req_1",
      version: "2.0.44",
      message: {
        id: "msg_1",
        model: "claude-sonnet-5",
        usage: { input_tokens: 12, output_tokens: 34, cache_creation_input_tokens: 56, cache_read_input_tokens: 78 },
      },
    });
    for (const secret of ["thinking", "response text", "sk-ant", "workspaces", "cwd", "content"]) {
      expect(jsonl).not.toContain(secret);
    }
  });

  it("keeps a pre-calculated cost and the api-error marker, which ccusage reads", () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-11T10:00:21.000Z",
      costUSD: 0.42,
      isApiErrorMessage: true,
      message: { usage: { input_tokens: 1, output_tokens: 2 } },
    });
    const { jsonl } = minimizeClaudeSessionJsonl(`${line}\n`, SESSION_ID);
    const kept = JSON.parse(jsonl.trim()) as Record<string, unknown>;
    expect(kept.costUSD).toBe(0.42);
    expect(kept.isApiErrorMessage).toBe(true);
    // The transcript line never named its session; the snapshot fills in the known one.
    expect(kept.sessionId).toBe(SESSION_ID);
  });

  it("counts malformed lines instead of failing, and produces nothing from a usage-free transcript", () => {
    const result = minimizeClaudeSessionJsonl(`not json\n${promptLine}\n{"type":"summary"}\n`, SESSION_ID);
    expect(result).toEqual({ jsonl: "", kept: 0, malformed: 1 });
  });
});

describe("collectUsageSnapshots", () => {
  let home: string;
  const logs: string[] = [];
  const log = (text: string): void => {
    logs.push(text);
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "brevi-usage-"));
    logs.length = 0;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const writeTranscript = (root: string, sessionId: string, content: string): string => {
    const dir = join(home, root, "projects", "-home-brevi-workspace");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${sessionId}.jsonl`);
    writeFileSync(path, content);
    return path;
  };

  it("finds the captured session under .claude/projects and hashes its sanitized snapshot", async () => {
    writeTranscript(".claude", SESSION_ID, `${promptLine}\n${assistantLine}\n`);
    const snapshots = await collectUsageSnapshots({ homePath: home, projectKey: "brevi-a-b", sessionId: SESSION_ID, log });
    expect(snapshots).toHaveLength(1);
    const snapshot = snapshots[0]!;
    expect(snapshot.source).toBe("claude");
    expect(snapshot.projectKey).toBe("brevi-a-b");
    expect(snapshot.sessionId).toBe(SESSION_ID);
    expect(snapshot.jsonl).not.toContain("secret");
    expect(snapshot.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("finds a session under the .config/claude variant too", async () => {
    writeTranscript(join(".config", "claude"), SESSION_ID, `${assistantLine}\n`);
    const snapshots = await collectUsageSnapshots({ homePath: home, projectKey: "brevi-a-b", sessionId: SESSION_ID, log });
    expect(snapshots).toHaveLength(1);
  });

  it("exports every session in the home when no id is given: the attach re-export", async () => {
    writeTranscript(".claude", SESSION_ID, `${assistantLine}\n`);
    writeTranscript(".claude", "66666666-7777-8888-9999-000000000000", `${assistantLine}\n`);
    const snapshots = await collectUsageSnapshots({ homePath: home, projectKey: "brevi-a-b", log });
    expect(snapshots.map((s) => s.sessionId).sort()).toEqual(["11111111-2222-3333-4444-555555555555", "66666666-7777-8888-9999-000000000000"]);
  });

  it("logs and returns nothing for a missing transcript rather than failing", async () => {
    const snapshots = await collectUsageSnapshots({ homePath: home, projectKey: "brevi-a-b", sessionId: SESSION_ID, log });
    expect(snapshots).toEqual([]);
    expect(logs.some((line) => line.includes("no transcript"))).toBe(true);
  });

  it("refuses a transcript that is a symlink out of the sandbox home", async () => {
    const outside = join(home, "..", `brevi-usage-outside-${Date.now()}.jsonl`);
    writeFileSync(outside, `${assistantLine}\n`);
    try {
      const dir = join(home, ".claude", "projects", "-home-brevi-workspace");
      mkdirSync(dir, { recursive: true });
      symlinkSync(outside, join(dir, `${SESSION_ID}.jsonl`));
      const snapshots = await collectUsageSnapshots({ homePath: home, projectKey: "brevi-a-b", sessionId: SESSION_ID, log });
      expect(snapshots).toEqual([]);
      expect(logs.some((line) => line.includes("could not read session"))).toBe(true);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it("refuses to scan a projects tree reached through a symlinked directory", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "brevi-usage-elsewhere-"));
    try {
      const realProjects = join(elsewhere, "projects", "some-dir");
      mkdirSync(realProjects, { recursive: true });
      writeFileSync(join(realProjects, `${SESSION_ID}.jsonl`), `${assistantLine}\n`);
      mkdirSync(join(home, ".claude"), { recursive: true });
      symlinkSync(join(elsewhere, "projects"), join(home, ".claude", "projects"));
      const snapshots = await collectUsageSnapshots({ homePath: home, projectKey: "brevi-a-b", sessionId: SESSION_ID, log });
      expect(snapshots).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("skips a usage-free transcript quietly and a malformed one with a diagnostic", async () => {
    writeTranscript(".claude", SESSION_ID, `${promptLine}\nnot json at all\n`);
    const snapshots = await collectUsageSnapshots({ homePath: home, projectKey: "brevi-a-b", sessionId: SESSION_ID, log });
    expect(snapshots).toEqual([]);
    expect(logs.some((line) => line.includes("malformed"))).toBe(true);
  });
});
