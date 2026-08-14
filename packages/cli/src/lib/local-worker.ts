import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { LOGS_DIR, type HostExecution } from "@brevi/shared";
import { loadMacVmSettings } from "../mac/state.js";
import { isStandaloneBinary } from "./worker-binary.js";

/**
 * Zero-enrollment execution: `brevi start` spawns and supervises a `brevi
 * worker` on loopback when this machine can run sandboxes, so a first run
 * needs no pairing ceremony. `resolveHostExecution` decides what the machine
 * executes through (reported on /api/health); `superviseLocalWorker` is the
 * process supervision that decision implies.
 */

/** ~/.brevi/logs/local-worker.log, the local worker child's stdout/stderr and this supervisor's own status lines. */
const LOCAL_WORKER_LOG_PATH = join(LOGS_DIR, "local-worker.log");

/** Backoff schedule for a crash-looping local worker; see nextRestartDelay. */
export const INITIAL_RESTART_DELAY_MS = 1_000;
export const MAX_RESTART_DELAY_MS = 30_000;
/** A child that stayed up this long counts as healthy: the next crash, if any, restarts the backoff from the top. */
export const HEALTHY_UPTIME_MS = 60_000;
/** How long stop() waits before SIGKILL: 5s past the worker's own 30s drain deadline (SHUTDOWN_DEADLINE_MS in @brevi/worker). */
const STOP_GRACEFUL_TIMEOUT_MS = 35_000;

// -- host execution ---------------------------------------------------------

/** Pure form of resolveHostExecution's decision, testable without the filesystem or process.platform. */
export function decideHostExecution(platform: NodeJS.Platform, macVmInstalled: boolean): HostExecution {
  if (platform === "linux") return { kind: "local-worker" };
  if (platform === "darwin") {
    return macVmInstalled ? { kind: "mac-vm" } : { kind: "none", reason: "macos-vm-not-installed" };
  }
  return { kind: "none", reason: "unsupported-platform" };
}

/**
 * What this machine can execute runs through. "Installed" mirrors `brevi mac
 * status`/`uninstall`: mac-vm.json exists and parses, whether or not the VM
 * is running right now.
 */
export async function resolveHostExecution(): Promise<HostExecution> {
  const macVmInstalled = process.platform === "darwin" ? (await loadMacVmSettings()) !== undefined : false;
  return decideHostExecution(process.platform, macVmInstalled);
}

// -- crash backoff ------------------------------------------------------

/**
 * Delay before the next restart: doubles up to MAX_RESTART_DELAY_MS, and a
 * child that reached HEALTHY_UPTIME_MS resets it to the initial 1s, so a
 * crash after a healthy run doesn't inherit an earlier crash loop's backoff.
 */
export function nextRestartDelay(previousDelayMs: number, uptimeMs: number): number {
  if (uptimeMs >= HEALTHY_UPTIME_MS) return INITIAL_RESTART_DELAY_MS;
  return Math.min(previousDelayMs * 2, MAX_RESTART_DELAY_MS);
}

// -- supervising the child ------------------------------------------------

export interface SuperviseLocalWorkerOptions {
  /** Loopback URL of the orchestrator this worker dials, e.g. http://127.0.0.1:4400. */
  hostUrl: string;
  /** Minted by OrchestratorHandle.ensureLocalWorker and injected into the child: no pairing ceremony. */
  workerId: string;
  credential: string;
  /** Supervisor status lines; defaults to timestamped lines in local-worker.log alongside the child's stdio. */
  logger?: (line: string) => void;
}

export interface LocalWorkerHandle {
  /** Stops accepting restarts, drains the child (SIGTERM, then SIGKILL after a grace period), and resolves once it's gone. Idempotent. */
  stop(): Promise<void>;
}

/**
 * The argv that re-invokes this CLI with the given args. A standalone
 * build's execPath is the whole CLI and its argv[1] is a virtual `/$bunfs/`
 * path, so the child gets no entry script (the rule `brevi worker update`
 * follows); under node, the entry is argv[1] resolved past a `.bin` symlink.
 */
async function resolveCliArgv(args: string[]): Promise<string[]> {
  if (isStandaloneBinary()) return args;
  const entry = process.argv[1] ?? fileURLToPath(import.meta.url);
  try {
    return [await realpath(entry), ...args];
  } catch {
    return [resolvePath(entry), ...args];
  }
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

/**
 * Spawns `brevi worker --host <hostUrl>` and keeps it running: restarts a
 * crashed child with capped, resetting backoff (see nextRestartDelay) and
 * drains it on stop(). The child's stdio goes to
 * ~/.brevi/logs/local-worker.log, never the console.
 */
export function superviseLocalWorker(options: SuperviseLocalWorkerOptions): LocalWorkerHandle {
  mkdirSync(LOGS_DIR, { recursive: true });
  const logFd = openSync(LOCAL_WORKER_LOG_PATH, "a");

  const log =
    options.logger ??
    ((line: string) => {
      try {
        writeSync(logFd, `${new Date().toISOString()} [brevi local-worker] ${line}\n`);
      } catch {
        // Best-effort: a broken log file must never break local worker supervision.
      }
    });

  let stopping = false;
  let child: ChildProcess | null = null;
  let childStartedAt = 0;
  let restartDelayMs = INITIAL_RESTART_DELAY_MS;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let cliArgv: string[] | undefined;
  let logFdClosed = false;

  const closeLogFd = (): void => {
    if (logFdClosed) return;
    logFdClosed = true;
    try {
      closeSync(logFd);
    } catch {
      // Best-effort.
    }
  };

  const scheduleRestart = (uptimeMs: number): void => {
    const delay = restartDelayMs;
    restartDelayMs = nextRestartDelay(delay, uptimeMs);
    log(`restarting in ${delay}ms`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      void spawnChild();
    }, delay);
  };

  async function spawnChild(): Promise<void> {
    if (stopping) return;
    if (cliArgv === undefined) cliArgv = await resolveCliArgv(["worker", "--host", options.hostUrl]);
    if (stopping) return; // stop() may have landed while resolving the entry path

    childStartedAt = Date.now();
    const proc = spawn(process.execPath, cliArgv, {
      env: {
        ...process.env,
        BREVI_WORKER_ID: options.workerId,
        BREVI_WORKER_CREDENTIAL: options.credential,
        BREVI_WORKER_SUPERVISOR_PID: String(process.pid),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    log(`spawned pid ${proc.pid ?? "?"}`);

    const pipeToLog = (chunk: Buffer): void => {
      try {
        writeSync(logFd, chunk);
      } catch {
        // Best-effort.
      }
    };
    proc.stdout?.on("data", pipeToLog);
    proc.stderr?.on("data", pipeToLog);

    proc.once("exit", (code, signal) => {
      if (child !== proc) return; // superseded by a later spawn or stop()
      child = null;
      const uptimeMs = Date.now() - childStartedAt;
      log(`exited (code ${code ?? "null"}, signal ${signal ?? "null"}) after ${uptimeMs}ms`);
      if (stopping) return;
      scheduleRestart(uptimeMs);
    });

    proc.once("error", (err) => {
      if (child !== proc) return;
      child = null;
      log(`failed to spawn: ${err instanceof Error ? err.message : String(err)}`);
      if (stopping) return;
      scheduleRestart(Date.now() - childStartedAt);
    });
  }

  void spawnChild();

  return {
    async stop(): Promise<void> {
      if (stopping) {
        // Idempotent: a second call just waits behind the first's teardown.
        if (child) await waitForExit(child);
        return;
      }
      stopping = true;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }

      const proc = child;
      if (!proc) {
        closeLogFd();
        return;
      }

      log("stopping: sending SIGTERM");
      const exited = waitForExit(proc);
      proc.kill("SIGTERM");

      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<void>((resolve) => {
        graceTimer = setTimeout(resolve, STOP_GRACEFUL_TIMEOUT_MS);
      });
      await Promise.race([exited, grace]);
      clearTimeout(graceTimer);

      if (proc.exitCode === null && proc.signalCode === null) {
        log("did not exit within the grace period; sending SIGKILL");
        proc.kill("SIGKILL");
        await exited;
      }

      child = null;
      closeLogFd();
    },
  };
}
