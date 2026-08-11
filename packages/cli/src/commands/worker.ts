import { WORKER_MAX_CONCURRENCY } from "@brevi/shared";
import { enrollmentFor, runWorker } from "@brevi/worker";
import type { Command } from "commander";
import pc from "picocolors";
import { errorMessage } from "../lib/util.js";

interface WorkerCommandOptions {
  host: string;
  token?: string;
  name?: string;
  concurrency?: string;
}

export function registerWorkerCommand(program: Command): void {
  program
    .command("worker")
    .description("Enroll this machine as a worker, or reconnect an enrolled one")
    // Required, with no fallback to the local config: which brevi instance a
    // worker belongs to is the host's business, not something this machine's
    // own config (if it even has one) could know.
    .requiredOption("--host <url>", "the brevi host to work for, e.g. http://192.168.1.5:4400")
    .option(
      "--token <token>",
      "single-use pairing token minted on the host's Workers page; needed only to enroll this machine, or to enroll it again after its credential was revoked",
    )
    .option(
      "--name <name>",
      "name to enroll under (default: this machine's hostname); the host keeps its own name for this worker afterwards, so later renames happen on the dashboard",
    )
    .option(
      "--concurrency <n>",
      "how many dispatched runs to execute at once (default: the local config's sandbox.concurrency, or 1 on a machine with no brevi config)",
    )
    .action(async (options: WorkerCommandOptions) => {
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

      // Enrollment is the only way onto a host's fleet, and a pairing token is
      // the only way to enroll: without one, and without a credential an
      // earlier enrollment with this host left behind, there is nothing to
      // connect with. Said here rather than after the sandbox provider has
      // been resolved, which can take minutes on a first run.
      if (!options.token && !(await enrollmentFor(options.host))) {
        console.error(pc.red(`✖ This machine is not enrolled with ${options.host}, and no --token was given.`));
        console.error(
          pc.dim(
            '  Open Configuration > Workers on that host and use "Add a worker": it mints a pairing token and shows the exact command to run here.',
          ),
        );
        process.exit(1);
      }

      try {
        await runWorker({ hostUrl: options.host, token: options.token, name: options.name, concurrency });
      } catch (err) {
        console.error(pc.red(`✖ ${errorMessage(err)}`));
        process.exit(1);
      }
    });
}
