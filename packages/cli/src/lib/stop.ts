import { loadConfig } from "@brevi/orchestrator";
import { isHealthResponse } from "@brevi/shared";
import pc from "picocolors";
import { pidListeningOnPort, readPidFile, removePidFile } from "./pid.js";
import { errorMessage } from "./util.js";

const HEALTH_TIMEOUT_MS = 2000;
const GRACEFUL_TIMEOUT_MS = 10_000;
const FORCE_TIMEOUT_MS = 2000;
const POLL_INTERVAL_MS = 200;

/**
 * Pid of the running server, or null when none is: the pid file first, then
 * the configured-port fallback for servers started before pid files existed.
 */
export async function findRunningServer(): Promise<number | null> {
  return readPidFile() ?? (await pidFromConfiguredPort());
}

/**
 * Stops the server process behind `brevi stop` and the post-update restart:
 * SIGTERM triggers the server's graceful shutdown (which stops the
 * orchestrator and any child processes it spawned), escalating to SIGKILL
 * when it doesn't exit in time. Prints progress; false when the process could
 * not be signalled or is still running afterwards.
 */
export async function stopServer(pid: number): Promise<boolean> {
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    console.error(pc.red(`✖ Could not signal process ${pid}: ${errorMessage(err)}`));
    return false;
  }

  if (!(await waitForExit(pid, GRACEFUL_TIMEOUT_MS))) {
    console.log(
      pc.yellow(`! Process ${pid} did not exit within ${GRACEFUL_TIMEOUT_MS / 1000}s, sending SIGKILL...`),
    );
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Exited between the check and the kill, which is what we wanted.
    }
    if (!(await waitForExit(pid, FORCE_TIMEOUT_MS))) {
      console.error(pc.red(`✖ Process ${pid} is still running.`));
      return false;
    }
  }

  // The server removes its own pid file on a clean exit; this covers the
  // SIGKILL path and pids found through the port fallback.
  removePidFile();
  return true;
}

/**
 * Fallback for servers started before pid files existed: if the health
 * endpoint on the configured port answers with a brevi health payload (so the
 * listener really is brevi, not an unrelated service that happens to serve
 * /api/health), return the pid listening there.
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
    const body: unknown = await res.json();
    if (!isHealthResponse(body)) return null;
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
