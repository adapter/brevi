import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { collectBwrapProblems, collectSeatbeltProblems, resolveBinary } from "@brevi/sandbox";
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

/**
 * A GUI-launched app inherits launchd's minimal PATH, which hides agent CLIs
 * installed via Homebrew, npm prefixes, or version managers. Resolve the
 * user's login-shell PATH once and merge it (plus the usual install
 * locations) into this process before the worker probes for agents.
 */
let pathEnsured: Promise<void> | undefined;
export function ensureUsablePath(): Promise<void> {
  pathEnsured ??= (async () => {
    const shellPath = await loginShellPath();
    const fallbacks = [
      "/opt/homebrew/bin",
      "/usr/local/bin",
      join(homedir(), ".local", "bin"),
      join(homedir(), ".bun", "bin"),
    ];
    const parts = [
      ...(shellPath ?? "").split(delimiter),
      ...(process.env.PATH ?? "").split(delimiter),
      ...fallbacks,
    ].filter(Boolean);
    process.env.PATH = [...new Set(parts)].join(delimiter);
  })();
  return pathEnsured;
}

const PATH_MARKER = "__BREVI_PATH__";

function loginShellPath(): Promise<string | undefined> {
  const shell = process.env.SHELL || "/bin/zsh";
  return new Promise((resolve) => {
    execFile(
      shell,
      ["-l", "-c", `printf "%s%s" "${PATH_MARKER}" "$PATH"`],
      { timeout: 8_000 },
      (error, stdout) => {
        // An rc file can print banners before our marker; take only what
        // follows the last marker and up to the next newline, so shell noise
        // never contaminates PATH.
        if (error) return resolve(undefined);
        const at = stdout.lastIndexOf(PATH_MARKER);
        if (at === -1) return resolve(undefined);
        const value = stdout.slice(at + PATH_MARKER.length).split("\n", 1)[0]?.trim();
        resolve(value || undefined);
      },
    );
  });
}

/**
 * What this machine can execute runs through, reported on /api/health. The
 * configured agent command is probed alongside the three defaults so a custom
 * wrapper or an absolute CLI path (exactly what the worker's own
 * availableAgentCommands accepts) does not read as "no agent CLI".
 */
export async function resolveHostExecution(configuredCommand?: string): Promise<HostExecution> {
  await ensureUsablePath();
  if (process.platform === "linux") {
    if ((await collectBwrapProblems()).length > 0) return { kind: "none", reason: "bwrap-unavailable" };
  } else if (process.platform === "darwin") {
    if ((await collectSeatbeltProblems()).length > 0)
      return { kind: "none", reason: "seatbelt-unavailable" };
  } else {
    return { kind: "none", reason: "unsupported-platform" };
  }
  // A healthy sandbox with no agent CLI still cannot execute anything, and
  // advertising local-worker would hide the queue-only setup notice.
  const candidates = new Set(["claude", "codex", "grok"]);
  if (configuredCommand) candidates.add(configuredCommand);
  const resolved = await Promise.all([...candidates].map((cmd) => resolveBinary(cmd)));
  if (resolved.every((r) => r === undefined)) return { kind: "none", reason: "no-agent-cli" };
  return { kind: "local-worker" };
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
  // The loopback dashboard listener serves WORKER_WS_PATH too, and unlike
  // the network fleet listener it always exists, so a fresh install with
  // fleet.host unset still gets local execution.
  const hostUrl = handle.url;

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
      if (stopping) return;
      abort = new AbortController();
      log(`starting against ${hostUrl}`);
      await runWorker({
        hostUrl,
        enrollment,
        name: "This machine",
        signal: abort.signal,
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
