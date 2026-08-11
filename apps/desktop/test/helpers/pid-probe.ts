// Runs a sequence of @brevi/orchestrator/pid operations (given as a JSON
// array on the PID_PROBE_OPS env var) against whatever HOME this process was
// spawned with, then prints a JSON array of results to stdout.
//
// Spawned as its own subprocess by pid.test.ts, with HOME set on that
// spawn's real environment: Bun's os.homedir() (which @brevi/shared's
// BREVI_HOME, and so the pid file path, is computed from) only honours HOME
// present on the process's environment at startup, not process.env mutated
// at runtime, so this can't be done by importing pid.ts directly into a
// bun:test file. Every operation runs within this one still-live process, so
// a written record's own pid reads back as alive.
import { mkdirSync, writeFileSync } from "node:fs";
import { BREVI_HOME, SERVER_PID_PATH } from "@brevi/shared";
import {
  desktopSupervisorPid,
  inspectPidFile,
  readServerRecord,
  removePidFile,
  writePidFile,
  type ServerOwner,
} from "@brevi/orchestrator/pid";

type Op =
  | { op: "write"; owner: ServerOwner; supervisorPid: number | null }
  // Bypasses writePidFile's validation to plant a legacy/malformed record;
  // "pid" is always overwritten with this process's own pid so liveness
  // checks against it succeed.
  | { op: "writeRaw"; raw: Record<string, unknown> }
  | { op: "read" }
  | { op: "desktopSupervisorPid" }
  | { op: "inspect" }
  | { op: "remove" };

const ops = JSON.parse(process.env.PID_PROBE_OPS ?? "[]") as Op[];
const results: unknown[] = [];

for (const entry of ops) {
  switch (entry.op) {
    case "write":
      writePidFile({ owner: entry.owner, supervisorPid: entry.supervisorPid });
      results.push({ ok: true, pid: process.pid });
      break;
    case "writeRaw": {
      mkdirSync(BREVI_HOME, { recursive: true });
      const raw = { ...entry.raw, pid: process.pid };
      writeFileSync(SERVER_PID_PATH, `${JSON.stringify(raw)}\n`);
      results.push({ ok: true, pid: process.pid });
      break;
    }
    case "read":
      results.push({ record: readServerRecord() });
      break;
    case "desktopSupervisorPid": {
      const record = readServerRecord();
      results.push({ supervisorPid: record ? desktopSupervisorPid(record) : null });
      break;
    }
    case "inspect":
      results.push({ state: inspectPidFile() });
      break;
    case "remove":
      removePidFile();
      results.push({ ok: true });
      break;
  }
}

process.stdout.write(JSON.stringify(results));
