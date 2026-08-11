import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, startOrchestrator } from "@brevi/orchestrator";
import open from "open";
import pc from "picocolors";
import { removePidFile, writePidFile } from "./pid.js";
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

/** Shared implementation behind the bare `brevi` invocation and `brevi start`. */
export async function runServer({ openBrowser }: RunServerOptions): Promise<void> {
  const config = await loadConfig().catch((err: unknown) => {
    console.error(pc.red(`✖ ${errorMessage(err)}`));
    console.error(pc.dim("  Run `npx @brevi/cli init` to create one."));
    process.exit(1);
  });

  const handle = await startOrchestrator({
    config,
    appDist: bundledAppDist(),
  }).catch((err: unknown) => {
    console.error(pc.red(`✖ Failed to start the orchestrator: ${errorMessage(err)}`));
    process.exit(1);
  });

  // Record our pid so `brevi stop` can find this process. Removed on exit;
  // a stale file left by a hard kill is detected and cleaned up by `stop`.
  writePidFile();
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
    void handle
      .stop()
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
