import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopSupervisorPid } from "@brevi/orchestrator/pid";

// Pid file ownership round trip (findings 4 and 5 from the desktop app
// review): owner/supervisorPid written by the desktop app or a plain CLI
// must read back correctly, and older/malformed records must parse
// tolerantly. Each scenario runs in its own subprocess with its own $HOME
// (see helpers/pid-probe.ts for why: Bun's os.homedir() only honours HOME
// set on a process's real environment at startup, not process.env mutated
// at runtime, so a temp $HOME can't be applied by mutating it in this file
// before importing the pid module), so none of this touches the real
// ~/.brevi.

const here = dirname(fileURLToPath(import.meta.url));
const probeEntry = join(here, "helpers", "pid-probe.ts");

/** A pid essentially guaranteed not to be a live process on this machine. */
const DEAD_PID = 999_999;

type Op =
  | { op: "write"; owner: "cli" | "desktop"; supervisorPid: number | null }
  | { op: "writeRaw"; raw: Record<string, unknown> }
  | { op: "read" }
  | { op: "desktopSupervisorPid" }
  | { op: "inspect" }
  | { op: "remove" };

/** Runs `ops` in order against a fresh temp $HOME, in one subprocess, returning each op's result. */
function runProbe(ops: Op[]): unknown[] {
  const home = mkdtempSync(join(tmpdir(), "brevi-pid-test-"));
  try {
    const out = execFileSync(process.execPath, [probeEntry], {
      env: { ...process.env, HOME: home, PID_PROBE_OPS: JSON.stringify(ops) },
      encoding: "utf8",
    });
    return JSON.parse(out) as unknown[];
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("pid file ownership", () => {
  test("round-trips owner and supervisorPid written by the desktop app", () => {
    const [, readResult] = runProbe([
      { op: "write", owner: "desktop", supervisorPid: 4242 },
      { op: "read" },
    ]) as [unknown, { record: { pid: number; owner: string; supervisorPid: number | null } }];
    expect(readResult.record.owner).toBe("desktop");
    expect(readResult.record.supervisorPid).toBe(4242);
    expect(Number.isInteger(readResult.record.pid)).toBe(true);
  });

  test("round-trips a plain cli record with no supervisor", () => {
    const [, readResult] = runProbe([
      { op: "write", owner: "cli", supervisorPid: null },
      { op: "read" },
    ]) as [unknown, { record: { owner: string; supervisorPid: number | null } }];
    expect(readResult.record.owner).toBe("cli");
    expect(readResult.record.supervisorPid).toBeNull();
  });

  test("desktopSupervisorPid is null when the recorded supervisor is not alive", () => {
    const [, result] = runProbe([
      { op: "write", owner: "desktop", supervisorPid: DEAD_PID },
      { op: "desktopSupervisorPid" },
    ]) as [unknown, { supervisorPid: number | null }];
    expect(result.supervisorPid).toBeNull();
  });

  test("desktopSupervisorPid is null for a cli-owned record even with a supervisorPid field", () => {
    // Pure function, no file IO: safe to call in-process directly.
    expect(desktopSupervisorPid({ pid: process.pid, owner: "cli", supervisorPid: process.pid })).toBeNull();
  });

  test("a legacy record with no owner field reads back as cli, no supervisor", () => {
    const [, readResult] = runProbe([
      { op: "writeRaw", raw: { startedAt: "" } },
      { op: "read" },
    ]) as [unknown, { record: { owner: string; supervisorPid: number | null } }];
    expect(readResult.record.owner).toBe("cli");
    expect(readResult.record.supervisorPid).toBeNull();
  });

  test("a malformed supervisorPid (wrong type) reads back as null", () => {
    const [, readResult] = runProbe([
      { op: "writeRaw", raw: { startedAt: "", owner: "desktop", supervisorPid: "not-a-number" } },
      { op: "read" },
    ]) as [unknown, { record: { owner: string; supervisorPid: number | null } }];
    expect(readResult.record.owner).toBe("desktop");
    expect(readResult.record.supervisorPid).toBeNull();
  });

  test("a malformed owner value falls back to cli", () => {
    const [, readResult] = runProbe([
      { op: "writeRaw", raw: { startedAt: "", owner: "not-a-real-owner" } },
      { op: "read" },
    ]) as [unknown, { record: { owner: string } }];
    expect(readResult.record.owner).toBe("cli");
  });

  test("inspectPidFile surfaces owner on the alive variant without cleaning up the file", () => {
    const [, inspectResult, readAfter] = runProbe([
      { op: "write", owner: "desktop", supervisorPid: 4242 },
      { op: "inspect" },
      { op: "read" },
    ]) as [unknown, { state: { state: string; owner?: string } }, { record: unknown }];
    expect(inspectResult.state.state).toBe("alive");
    expect(inspectResult.state.owner).toBe("desktop");
    // Still there afterwards: inspect is read-only, unlike readServerRecord.
    expect(readAfter.record).not.toBeNull();
  });
});
