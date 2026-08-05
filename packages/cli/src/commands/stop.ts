import { loadConfig } from "@brevi/orchestrator";
import type { Command } from "commander";
import pc from "picocolors";
import { pidListeningOnPort, readPidFile, removePidFile } from "../lib/pid.js";
import { errorMessage } from "../lib/util.js";

const HEALTH_TIMEOUT_MS = 2000;
const GRACEFUL_TIMEOUT_MS = 10_000;
const FORCE_TIMEOUT_MS = 2000;
const POLL_INTERVAL_MS = 200;

export function registerStopCommand(program: Command): void {
  program
    .command("stop")
    .description("Stop the running brevi orchestrator")
    .action(async () => {
      const pid = readPidFile() ?? (await pidFromConfiguredPort());
      if (pid === null) {
        console.log(pc.yellow("✖ brevi is not running."));
        console.log(pc.dim("  Start it with `npx @brevi/cli` or `npx @brevi/cli start`."));
        process.exit(1);
      }

      // SIGTERM triggers the server's graceful shutdown, which stops the
      // orchestrator and any child processes it spawned.
      try {
        process.kill(pid, "SIGTERM");
      } catch (err) {
        console.error(pc.red(`✖ Could not signal process ${pid}: ${errorMessage(err)}`));
        process.exit(1);
      }

      if (!(await waitForExit(pid, GRACEFUL_TIMEOUT_MS))) {
        console.log(
          pc.yellow(`! Process ${pid} did not exit within ${GRACEFUL_TIMEOUT_MS / 1000}s, sending SIGKILL...`),
        );
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Exited between the check and the kill — that's what we wanted.
        }
        if (!(await waitForExit(pid, FORCE_TIMEOUT_MS))) {
          console.error(pc.red(`✖ Process ${pid} is still running.`));
          process.exit(1);
        }
      }

      // The server removes its own pid file on a clean exit; this covers the
      // SIGKILL path and pids found through the port fallback.
      removePidFile();
      console.log(pc.green(`✔ Stopped brevi (pid ${pid}).`));
    });
}

/**
 * Fallback for servers started before pid files existed: if the health
 * endpoint on the configured port answers (so the listener really is brevi),
 * return the pid listening there.
 */
async function pidFromConfiguredPort(): Promise<number | null> {
  const config = await loadConfig().catch(() => null);
  if (!config) return null;

  const port = config.server.port;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`http://localhost:${port}/api/health`, { signal: controller.signal });
    if (!res.ok) return null;
    return await pidListeningOnPort(port);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Polls until `pid` is gone, resolving false when `timeoutMs` elapses first. */
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return false;
}
