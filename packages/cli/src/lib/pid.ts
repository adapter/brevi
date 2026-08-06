import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { BREVI_HOME } from "@brevi/shared";

/**
 * Written by the server process on startup so `brevi stop` can find it.
 * Alongside the pid it records the process start time, so a pid the OS has
 * recycled for an unrelated process (after a hard kill or a reboot) is never
 * mistaken for the server.
 */
const PID_PATH = join(BREVI_HOME, "server.pid");

interface PidFileRecord {
  pid: number;
  /** `ps -o lstart=` output at write time; empty where unavailable (win32). */
  startedAt: string;
}

export function writePidFile(): void {
  mkdirSync(BREVI_HOME, { recursive: true });
  const record: PidFileRecord = {
    pid: process.pid,
    startedAt: processStartTime(process.pid) ?? "",
  };
  writeFileSync(PID_PATH, `${JSON.stringify(record)}\n`);
}

export function removePidFile(): void {
  rmSync(PID_PATH, { force: true });
}

/**
 * Pid recorded in the pid file, or null when there is no file or the pid no
 * longer refers to the server that wrote it — the process is dead, or the OS
 * has reused the pid and its start time no longer matches the recorded one.
 * Stale files are removed on read.
 */
export function readPidFile(): number | null {
  let raw: string;
  try {
    raw = readFileSync(PID_PATH, "utf8");
  } catch {
    return null;
  }
  const record = parsePidFile(raw);
  if (!record || !isProcessAlive(record.pid) || isRecycledPid(record)) {
    removePidFile();
    return null;
  }
  return record.pid;
}

function parsePidFile(raw: string): PidFileRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { pid, startedAt } = value as Record<string, unknown>;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof startedAt !== "string") return null;
  return { pid, startedAt };
}

/** True when the pid now belongs to a different process than the one recorded. */
function isRecycledPid({ pid, startedAt }: PidFileRecord): boolean {
  if (!startedAt) return false;
  const current = processStartTime(pid);
  return current !== null && current !== startedAt;
}

/**
 * Process start time as reported by `ps` (e.g. "Tue Aug  5 09:14:02 2026").
 * Null where ps is unavailable (win32) or the query fails; callers then fall
 * back to plain aliveness checking.
 */
function processStartTime(pid: number): string | null {
  if (process.platform === "win32") return null;
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Polls for the pid file a freshly started server writes once it's up,
 * resolving null when none appears within `timeoutMs`. Used by `brevi update`
 * to confirm the restarted instance came up.
 */
export async function waitForPidFile(timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = readPidFile();
    if (pid !== null) return pid;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

const execFileAsync = promisify(execFile);

/**
 * Pid of the process listening on `port`, found with lsof. Fallback for
 * servers started before pid files existed; best-effort, unix-only.
 */
export async function pidListeningOnPort(port: number): Promise<number | null> {
  if (process.platform === "win32") return null;
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    const pid = Number.parseInt(stdout.trim().split("\n")[0] ?? "", 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
