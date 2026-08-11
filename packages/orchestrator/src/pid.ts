import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { BREVI_HOME, SERVER_PID_PATH } from "@brevi/shared";

/**
 * Written by the server process on startup so `brevi stop` can find it. Both
 * the CLI and the desktop app read it, since either one may be the process
 * running the server on a given machine. Alongside the pid it records the
 * process start time, so a pid the OS has recycled for an unrelated process
 * (after a hard kill or a reboot) is never mistaken for the server.
 */
const PID_PATH = SERVER_PID_PATH;

/** Who runs the server: a terminal (`brevi start`) or the desktop app's supervisor. */
export type ServerOwner = "cli" | "desktop";

interface PidFileRecord {
  pid: number;
  /** `ps -o lstart=` output at write time; empty where unavailable (win32). */
  startedAt: string;
  /** Absent on records written by an older CLI; parses as "cli". */
  owner?: ServerOwner;
  /** The desktop app's own pid, only present when owner is "desktop". */
  supervisorPid?: number;
}

/** Ownership recorded for a live server: who runs it, and (for the desktop app) its supervisor's pid. */
export interface ServerRecord {
  pid: number;
  owner: ServerOwner;
  /** Only meaningful (and only ever non-null) when owner is "desktop"; see desktopSupervisorPid. */
  supervisorPid: number | null;
}

export function writePidFile(ownership: { owner: ServerOwner; supervisorPid: number | null }): void {
  mkdirSync(BREVI_HOME, { recursive: true });
  const record: PidFileRecord = {
    pid: process.pid,
    startedAt: processStartTime(process.pid) ?? "",
    owner: ownership.owner,
    ...(ownership.supervisorPid !== null ? { supervisorPid: ownership.supervisorPid } : {}),
  };
  writeFileSync(PID_PATH, `${JSON.stringify(record)}\n`);
}

export function removePidFile(): void {
  rmSync(PID_PATH, { force: true });
}

/**
 * The pid file's record, or null when there is no file or the pid no longer
 * refers to the server that wrote it: the process is dead, or the OS has
 * reused the pid and its start time no longer matches the recorded one.
 * Stale files are removed on read. Tolerant of records written by an older
 * CLI with no owner/supervisorPid fields.
 */
export function readServerRecord(): ServerRecord | null {
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
  return toServerRecord(record);
}

/**
 * Pid recorded in the pid file, or null when there is no file or the pid no
 * longer refers to the server that wrote it. See readServerRecord; this is
 * the pid-only convenience most callers want.
 */
export function readPidFile(): number | null {
  return readServerRecord()?.pid ?? null;
}

/**
 * Pid of the desktop app's supervisor process, only when `record` names the
 * desktop app as the server's owner and that supervisor is still alive. A
 * supervisor pid is only meaningful while its process is running: the
 * desktop app quitting uncleanly leaves the pid file's owner as "desktop"
 * with no live supervisor behind it.
 */
export function desktopSupervisorPid(record: ServerRecord): number | null {
  if (record.owner !== "desktop" || record.supervisorPid === null) return null;
  return isProcessAlive(record.supervisorPid) ? record.supervisorPid : null;
}

export type PidFileState =
  | { state: "absent" }
  | { state: "invalid" }
  | { state: "stale"; pid: number }
  | { state: "alive"; pid: number; owner: ServerOwner };

/**
 * Read-only variant of readServerRecord for `brevi doctor`: classifies the
 * pid file without cleaning it up, so a diagnostic run never has the side
 * effect of deleting state a human might want to inspect.
 */
export function inspectPidFile(): PidFileState {
  let raw: string;
  try {
    raw = readFileSync(PID_PATH, "utf8");
  } catch {
    return { state: "absent" };
  }
  const record = parsePidFile(raw);
  if (!record) return { state: "invalid" };
  if (!isProcessAlive(record.pid) || isRecycledPid(record)) {
    return { state: "stale", pid: record.pid };
  }
  return { state: "alive", pid: record.pid, owner: record.owner ?? "cli" };
}

function toServerRecord(record: PidFileRecord): ServerRecord {
  return {
    pid: record.pid,
    owner: record.owner ?? "cli",
    supervisorPid: record.supervisorPid ?? null,
  };
}

function parsePidFile(raw: string): PidFileRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { pid, startedAt, owner, supervisorPid } = value as Record<string, unknown>;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof startedAt !== "string") return null;

  // Tolerant of missing or malformed new fields: an older CLI's record (no
  // owner/supervisorPid at all) and a corrupted one (wrong types) both parse
  // fine, they just read back with the defaults applied in toServerRecord.
  const parsedOwner: ServerOwner | undefined = owner === "desktop" || owner === "cli" ? owner : undefined;
  const parsedSupervisorPid: number | undefined =
    typeof supervisorPid === "number" && Number.isInteger(supervisorPid) && supervisorPid > 0
      ? supervisorPid
      : undefined;

  return { pid, startedAt, owner: parsedOwner, supervisorPid: parsedSupervisorPid };
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
