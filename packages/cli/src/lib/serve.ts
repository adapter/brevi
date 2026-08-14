import { existsSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, startOrchestrator, type OrchestratorHandle } from "@brevi/orchestrator";
import { readPidFile, removePidFile, writePidFile, type ServerOwner } from "@brevi/orchestrator/pid";
import { isHealthResponse, urlHost } from "@brevi/shared";
import open from "open";
import pc from "picocolors";
import { resolveHostExecution, superviseLocalWorker, type LocalWorkerHandle } from "./local-worker.js";
import { updateNotice } from "./update.js";
import { errorMessage } from "./util.js";
import { readPackageVersion } from "./version.js";

/**
 * The published CLI bundles the dashboard next to the entry file (dist/app).
 * In-repo builds don't have it; the orchestrator then falls back to
 * resolving the @brevi/app workspace package.
 */
function bundledAppDist(): string | undefined {
  const dist = join(dirname(fileURLToPath(import.meta.url)), "app");
  return existsSync(join(dist, "index.html")) ? dist : undefined;
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host.startsWith("127.") || host === "::1";
}

/**
 * Virtual interfaces whose host-side addresses are bound but useless to other
 * devices: docker/libvirt/LXC bridges and brevi's own microVM tap gateways.
 */
const VIRTUAL_INTERFACE_PREFIXES = ["docker", "br-", "veth", "virbr", "lxc", "lxd", "brevi-tap"];

/** The dashboard URLs other devices can open, when bound to a wildcard address. */
function lanUrls(host: string, port: number): string[] {
  if (!["0.0.0.0", "::", "::0", "0:0:0:0:0:0:0:0"].includes(host)) return [];
  const urls: string[] = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (VIRTUAL_INTERFACE_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        urls.push(`http://${address.address}:${port}`);
      }
    }
  }
  return urls;
}

export interface RunServerOptions {
  /** Open the dashboard URL in the default browser once it's up. */
  openBrowser: boolean;
}

const HEALTH_TIMEOUT_MS = 2000;

/**
 * Ownership to record in the pid file, from BREVI_SUPERVISOR_PID. This is
 * process provenance passed by the parent that spawned us, not persistent
 * configuration, the same category as the desktop app's BREVI_DESKTOP_CLI_ENTRY
 * development escape hatch: when the desktop app's supervisor spawns this
 * process it sets its own pid here, so the server can record who owns it.
 * Absent or malformed (a plain terminal `brevi start`) means "cli".
 */
function ownershipFromEnv(): { owner: ServerOwner; supervisorPid: number | null } {
  const raw = process.env.BREVI_SUPERVISOR_PID;
  const supervisorPid = raw ? Number(raw) : NaN;
  if (Number.isInteger(supervisorPid) && supervisorPid > 0) {
    return { owner: "desktop", supervisorPid };
  }
  return { owner: "cli", supervisorPid: null };
}

/**
 * True when a brevi orchestrator already answers on the configured port. The
 * health payload is checked, not just the connection, so an unrelated service
 * on that port is never mistaken for brevi.
 */
async function orchestratorAlreadyRunning(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/api/health`, { signal: controller.signal });
    if (!res.ok) return false;
    const body: unknown = await res.json();
    return isHealthResponse(body);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Shared implementation behind the bare `brevi` invocation and `brevi start`. */
export async function runServer({ openBrowser }: RunServerOptions): Promise<void> {
  const config = await loadConfig().catch((err: unknown) => {
    console.error(pc.red(`✖ ${errorMessage(err)}`));
    console.error(pc.dim("  Run `npx @brevi/cli init` to create one."));
    process.exit(1);
  });

  // The desktop app, or another terminal, may already be running an
  // orchestrator against this same ~/.brevi. Starting a second one would only
  // fail to bind the port, so attach to it the way the app does.
  const runningUrl = `http://${urlHost(config.server.host)}:${config.server.port}`;
  if (await orchestratorAlreadyRunning(runningUrl)) {
    const pid = readPidFile();
    console.log(
      pc.green(`✔ brevi is already running at ${pc.bold(pc.cyan(runningUrl))}${pid === null ? "" : ` (pid ${pid})`}`),
    );
    console.log(pc.dim("  Attached to that instance instead of starting a second one."));
    if (openBrowser) await open(runningUrl).catch(() => undefined);
    return;
  }

  const hostExecution = await resolveHostExecution();

  const handle: OrchestratorHandle = await startOrchestrator({
    config,
    appDist: bundledAppDist(),
    hostExecution,
  }).catch((err: unknown) => {
    console.error(pc.red(`✖ Failed to start the orchestrator: ${errorMessage(err)}`));
    process.exit(1);
  });

  // Record our pid so `brevi stop` can find this process. Removed on exit;
  // a stale file left by a hard kill is detected and cleaned up by `stop`.
  writePidFile(ownershipFromEnv());
  process.on("exit", removePidFile);

  const urls = [handle.url, ...lanUrls(config.server.host, handle.port)];
  if (urls.length === 1) {
    console.log(pc.green(`✔ brevi is running at ${pc.bold(pc.cyan(handle.url))}`));
  } else {
    console.log(pc.green("✔ brevi is running at:"));
    for (const url of urls) console.log(`    ${pc.bold(pc.cyan(url))}`);
  }

  if (!isLoopback(config.server.host)) {
    console.log(
      pc.yellow(
        "  ! brevi has no authentication: anyone who can reach this port gets full control, including a shell into sandboxes. Only bind beyond loopback on networks you trust.",
      ),
    );
  }

  if (openBrowser) {
    try {
      await open(handle.url);
    } catch {
      console.log(pc.dim("  Could not open a browser automatically; open the URL above manually."));
    }
  } else {
    console.log(
      pc.dim(
        urls.length === 1
          ? "  Open that URL in a browser to view the dashboard."
          : "  Open the localhost URL here, or the network URL from another device.",
      ),
    );
  }

  // Zero-enrollment execution: mint this host's own local worker and keep
  // it running, invisible outside the Workers page and local-worker.log.
  let localWorker: LocalWorkerHandle | undefined;
  if (hostExecution.kind === "local-worker") {
    try {
      const { workerId, credential } = await handle.ensureLocalWorker(hostname());
      // handle.url, not hardcoded loopback: a server.host bound to a
      // specific interface has no loopback listener to dial, and handle.url
      // is the dialable spelling for every bind.
      localWorker = superviseLocalWorker({
        hostUrl: handle.url,
        workerId,
        credential,
      });
      console.log(pc.dim("  Running a local worker on this machine."));
    } catch (err) {
      console.error(pc.yellow(`  ! Could not start this machine's local worker: ${errorMessage(err)}`));
    }
  }

  console.log(pc.dim("  Press Ctrl+C to stop."));

  // Fire-and-forget: prints a "new version available" line if npm answers in
  // time, and stays silent otherwise. Never delays or fails startup.
  void updateNotice(readPackageVersion()).then((notice) => {
    if (notice) console.log(notice);
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(pc.dim(`\nReceived ${signal}, shutting down...`));
    // Drain the local worker first, while the orchestrator is still up to
    // receive its final frames, then stop the orchestrator itself.
    void Promise.resolve(localWorker?.stop())
      .catch((err: unknown) => {
        console.error(pc.red(`✖ Error while stopping the local worker: ${errorMessage(err)}`));
      })
      .then(() => handle.stop())
      .catch((err: unknown) => {
        console.error(pc.red(`✖ Error while shutting down: ${errorMessage(err)}`));
      })
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep the process alive; shutdown() is responsible for exiting.
  await new Promise<void>(() => {});
}
