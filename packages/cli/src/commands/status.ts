import { urlHost, type HealthResponse } from "@brevi/shared";
import { loadConfig } from "@brevi/orchestrator";
import type { Command } from "commander";
import pc from "picocolors";
import { updateNotice } from "../lib/update.js";
import { errorMessage } from "../lib/util.js";
import { readPackageVersion } from "../lib/version.js";

const HEALTH_TIMEOUT_MS = 2000;

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Check whether the brevi orchestrator is running")
    .action(async () => {
      // Checked in parallel with the health request; prints nothing when up
      // to date or when npm can't be reached in time.
      const notice = updateNotice(readPackageVersion());

      const config = await loadConfig().catch((err: unknown) => {
        console.error(pc.red(`✖ ${errorMessage(err)}`));
        console.error(pc.dim("  Run `npx @brevi/cli` to create one."));
        process.exit(1);
      });

      const port = config.server.port;
      // Probe the address the server actually binds to (server.host), not a
      // hardcoded localhost.
      const url = `http://${urlHost(config.server.host)}:${port}/api/health`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const health = (await res.json()) as HealthResponse;
        console.log(pc.green(`✔ brevi is running on port ${pc.bold(String(port))}`));
        console.log(pc.dim(`  version: ${health.version}`));
        console.log(pc.dim(`  sandbox provider: ${health.sandboxProvider}`));
        await printNotice(notice);
      } catch {
        console.log(pc.yellow(`✖ brevi is not running on port ${port}`));
        console.log(pc.dim("  Start it with `npx @brevi/cli` or `npx @brevi/cli start`."));
        await printNotice(notice);
        process.exit(1);
      } finally {
        clearTimeout(timer);
      }
    });
}

async function printNotice(notice: Promise<string | null>): Promise<void> {
  const message = await notice;
  if (message) console.log(message);
}
