import { collectBwrapProblems, collectSeatbeltProblems } from "@brevi/sandbox";
import type { HostExecution } from "@brevi/shared";
import { runWorker } from "@brevi/worker";
import type { OrchestratorHandle } from "@brevi/orchestrator";
import { HEALTHY_UPTIME_MS, restartDelay } from "./backoff.js";

/**
 * Zero-enrollment execution on the Mission Control machine itself: when this
 * host can run its platform's sandbox (bwrap on Linux, Seatbelt on macOS),
 * the desktop runs a worker daemon in-process against the loopback fleet
 * listener, with a host-minted credential and no pairing ceremony.
 */

/** What this machine can execute runs through, reported on /api/health. */
export async function resolveHostExecution(): Promise<HostExecution> {
  if (process.platform === "linux") {
    return (await collectBwrapProblems()).length === 0
      ? { kind: "local-worker" }
      : { kind: "none", reason: "bwrap-unavailable" };
  }
  if (process.platform === "darwin") {
    return (await collectSeatbeltProblems()).length === 0
      ? { kind: "local-worker" }
      : { kind: "none", reason: "seatbelt-unavailable" };
  }
  return { kind: "none", reason: "unsupported-platform" };
}

export interface LocalWorkerHandle {
  /** Stops restarts, drains the daemon gracefully, and resolves once it's gone. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Keeps an in-process worker daemon running against `handle`'s fleet
 * listener: a credential is minted (rotated) through ensureLocalWorker, the
 * daemon dials loopback, and a crash restarts it with capped, resetting
 * backoff. The credential never leaves this process; runWorker receives it
 * as an injected enrollment, so nothing lands in argv, config, or disk.
 */
export function startLocalWorker(
  handle: OrchestratorHandle,
  log: (line: string) => void = (line) => console.log(`[brevi local-worker] ${line}`),
): LocalWorkerHandle {
  const fleetPort = handle.fleetPort;
  if (fleetPort === null) {
    log("fleet listener is disabled (fleet.host is empty); local execution stays off");
    return { stop: async () => undefined };
  }
  const hostUrl = `http://127.0.0.1:${fleetPort}`;

  let stopping = false;
  let attempts = 0;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let abort: AbortController | null = null;
  let running: Promise<void> | null = null;

  const cycle = async (): Promise<void> => {
    const startedAt = Date.now();
    try {
      // Every (re)start mints a fresh credential; the previous one is dead
      // the moment this resolves, which is exactly right for a restart.
      const enrollment = await handle.ensureLocalWorker("This machine");
      abort = new AbortController();
      log(`starting against ${hostUrl}`);
      await runWorker({
        hostUrl,
        enrollment,
        name: "This machine",
        signal: abort.signal,
        supervisorPid: process.pid,
      });
      if (!stopping) log("daemon stopped on its own");
    } catch (error) {
      if (!stopping) log(`daemon failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    abort = null;
    if (stopping) return;
    attempts = Date.now() - startedAt >= HEALTHY_UPTIME_MS ? 1 : attempts + 1;
    const delay = restartDelay(attempts);
    log(`restarting in ${delay}ms`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      running = cycle();
    }, delay);
  };

  running = cycle();

  return {
    async stop(): Promise<void> {
      if (stopping) {
        await running?.catch(() => undefined);
        return;
      }
      stopping = true;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      abort?.abort();
      await running?.catch(() => undefined);
      log("stopped");
    },
  };
}
