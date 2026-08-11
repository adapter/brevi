import { loadConfig } from "@brevi/orchestrator";
import { WORKER_MAX_CONCURRENCY } from "@brevi/shared";
import { runWorker } from "@brevi/worker";
import type { Command } from "commander";
import pc from "picocolors";
import { errorMessage } from "../lib/util.js";

interface WorkerCommandOptions {
  host?: string;
  token?: string;
  name?: string;
  concurrency?: string;
}

export function registerWorkerCommand(program: Command): void {
  program
    .command("worker")
    .description("Run an execution worker that connects to a brevi host and executes dispatched runs")
    .option("--host <url>", "brevi host to connect to (default: http://localhost:<server.port> from the local config)")
    .option("--token <token>", "pairing token (default: the local config's fleet.token)")
    .option("--name <name>", "name shown for this worker on the host's dashboard (default: this machine's hostname)")
    .option(
      "--concurrency <n>",
      "how many dispatched runs to execute at once (default: the local config's sandbox.concurrency)",
    )
    .action(async (options: WorkerCommandOptions) => {
      const config = await loadConfig().catch((err: unknown) => {
        console.error(pc.red(`✖ ${errorMessage(err)}`));
        console.error(pc.dim("  Run `npx @brevi/cli init` to create one."));
        process.exit(1);
      });

      const hostUrl = options.host ?? `http://localhost:${config.server.port}`;
      const token = options.token ?? config.fleet.token;
      if (!token) {
        console.error(pc.red("✖ No pairing token available."));
        console.error(
          pc.dim(
            "  Pass --token, or set fleet.token in this machine's config. The host generates one on first start; copy it from its dashboard or ~/.brevi/config.json.",
          ),
        );
        process.exit(1);
      }

      let concurrency: number | undefined;
      if (options.concurrency !== undefined) {
        concurrency = Number(options.concurrency);
        if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > WORKER_MAX_CONCURRENCY) {
          console.error(
            pc.red(
              `✖ --concurrency must be an integer between 1 and ${WORKER_MAX_CONCURRENCY}, got "${options.concurrency}".`,
            ),
          );
          process.exit(1);
        }
      }

      try {
        await runWorker({ hostUrl, token, name: options.name, concurrency });
      } catch (err) {
        console.error(pc.red(`✖ ${errorMessage(err)}`));
        process.exit(1);
      }
    });
}
