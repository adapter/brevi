import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { BREVI_HOME } from "@brevi/shared";

/** Written by the server process on startup so `brevi stop` can find it. */
const PID_PATH = join(BREVI_HOME, "server.pid");

export function writePidFile(): void {
  mkdirSync(BREVI_HOME, { recursive: true });
  writeFileSync(PID_PATH, `${process.pid}\n`);
}

export function removePidFile(): void {
  rmSync(PID_PATH, { force: true });
}

/**
 * Pid recorded in the pid file, or null when there is no file or the process
 * is no longer alive (a stale file, e.g. after a SIGKILL, is removed).
 */
export function readPidFile(): number | null {
  let raw: string;
  try {
    raw = readFileSync(PID_PATH, "utf8");
  } catch {
    return null;
  }
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) {
    removePidFile();
    return null;
  }
  return pid;
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
