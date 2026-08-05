import type { HealthResponse } from "@brevi/shared";
import { loadConfig } from "@brevi/orchestrator";
import type { Command } from "commander";
import pc from "picocolors";
import { errorMessage } from "../lib/util.js";

const HEALTH_TIMEOUT_MS = 2000;

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Check whether the brevi orchestrator is running")
    .action(async () => {
      const config = await loadConfig().catch((err: unknown) => {
        console.error(pc.red(`✖ ${errorMessage(err)}`));
        console.error(pc.dim("  Run `npx @brevi/cli init` to create one."));
        process.exit(1);
      });

      const port = config.server.port;
      const url = `http://localhost:${port}/api/health`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const health = (await res.json()) as HealthResponse;
        console.log(pc.green(`✔ brevi is running on port ${pc.bold(String(port))}`));
        console.log(pc.dim(`  version: ${health.version}`));
        console.log(pc.dim(`  sandbox provider: ${health.sandboxProvider}`));
      } catch {
        console.log(pc.yellow(`✖ brevi is not running on port ${port}`));
        console.log(pc.dim("  Start it with `npx @brevi/cli` or `npx @brevi/cli start`."));
        process.exit(1);
      } finally {
        clearTimeout(timer);
      }
    });
}
