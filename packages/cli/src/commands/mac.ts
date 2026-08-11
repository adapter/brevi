import type { Command } from "commander";
import pc from "picocolors";
import { errorMessage } from "../lib/util.js";
import { installMacWorker, reportMacWorkerStatus, uninstallMacWorker } from "../mac/install.js";
import { limaStart, limaStatus, limaStop } from "../mac/limactl.js";
import { MAC_WORKER_REQUIREMENT } from "../mac/preflight.js";
import { loadMacVmSettings } from "../mac/state.js";
import { runSupervisor } from "../mac/supervisor.js";

/**
 * The `brevi mac` command layer: registers `install`/`status`/`start`/`stop`/
 * `uninstall`/`supervise`, all of which are pure wiring over
 * `packages/cli/src/mac/`. Every subcommand refuses immediately on a
 * non-macOS host through `requireMacos`, before touching anything.
 */

interface InstallCliOptions {
  host?: string;
  token?: string;
  cpus?: string;
  memory?: string;
  disk?: string;
  idleStop?: string;
  concurrency?: string;
  name?: string;
  yes?: boolean;
}

function requireMacos(): void {
  if (process.platform === "darwin") return;
  console.error(pc.red(`✖ ${MAC_WORKER_REQUIREMENT}`));
  console.error(pc.dim(`  This machine is running ${process.platform}, not macOS.`));
  process.exit(1);
}

/** Parses a required-integer CLI flag, exiting with a clear error on anything else. */
function parseIntFlag(raw: string | undefined, flagName: string, min: number): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    console.error(pc.red(`✖ ${flagName} must be an integer >= ${min}, got "${raw}".`));
    process.exit(1);
  }
  return value;
}

async function requireSettingsOrExit() {
  const settings = await loadMacVmSettings();
  if (settings === undefined) {
    console.error(pc.red("✖ The macOS worker is not installed."));
    console.error(pc.dim("  Run `brevi mac install` first."));
    process.exit(1);
  }
  return settings;
}

export function registerMacCommand(program: Command): void {
  const mac = program
    .command("mac")
    .description(
      "Manage the Linux VM that runs brevi's worker on this Mac (Apple silicon M3 or newer, macOS 15+)",
    );

  mac
    .command("install")
    .description("Set up and start the managed macOS worker VM")
    .option("--host <url>", "brevi host to connect to (default: http://localhost:<server.port> from the local config)")
    .option(
      "--token <token>",
      'single-use pairing token minted on the host\'s Workers page ("Add a worker"); not needed when the guest is already enrolled',
    )
    .option("--cpus <n>", "vCPUs given to the VM")
    .option("--memory <gib>", "memory given to the VM, in GiB")
    .option("--disk <gib>", "disk given to the VM, in GiB")
    .option("--idle-stop <minutes>", "minutes idle before the VM stops automatically (0 disables it)")
    .option("--concurrency <n>", "how many dispatched runs the guest worker executes at once")
    .option("--name <name>", "name shown for this worker on the host's dashboard")
    .option("-y, --yes", "answer every prompt with its default-yes and never wait for input")
    .action(async (options: InstallCliOptions) => {
      requireMacos();
      const ok = await installMacWorker({
        hostUrl: options.host,
        token: options.token,
        cpus: parseIntFlag(options.cpus, "--cpus", 1),
        memoryGiB: parseIntFlag(options.memory, "--memory", 1),
        diskGiB: parseIntFlag(options.disk, "--disk", 1),
        idleStopMinutes: parseIntFlag(options.idleStop, "--idle-stop", 0),
        concurrency: parseIntFlag(options.concurrency, "--concurrency", 1),
        workerName: options.name,
        assumeYes: options.yes === true,
      });
      if (!ok) process.exit(1);
    });

  mac
    .command("status")
    .description("Show what is installed and what the VM is doing right now")
    .action(async () => {
      requireMacos();
      await reportMacWorkerStatus();
    });

  mac
    .command("start")
    .description("Start the managed macOS worker VM")
    .action(async () => {
      requireMacos();
      const settings = await requireSettingsOrExit();
      try {
        await limaStart(settings.name);
      } catch (err) {
        console.error(pc.red(`✖ ${errorMessage(err)}`));
        process.exit(1);
      }
      console.log(`VM "${settings.name}" is now ${await limaStatus(settings.name)}.`);
    });

  mac
    .command("stop")
    .description("Stop the managed macOS worker VM")
    .action(async () => {
      requireMacos();
      const settings = await requireSettingsOrExit();
      try {
        await limaStop(settings.name);
      } catch (err) {
        console.error(pc.red(`✖ ${errorMessage(err)}`));
        process.exit(1);
      }
      console.log(`VM "${settings.name}" is now ${await limaStatus(settings.name)}.`);
    });

  mac
    .command("uninstall")
    .description("Remove the managed macOS worker VM, its launchd agent, and all saved state")
    .option("-y, --yes", "do not prompt for confirmation")
    .action(async (options: { yes?: boolean }) => {
      requireMacos();
      const ok = await uninstallMacWorker({ assumeYes: options.yes === true });
      if (!ok) process.exit(1);
    });

  mac
    .command("supervise")
    .description(
      "Run the supervisor loop that starts and stops the VM based on host demand (the launchd entry point; not meant to be run by hand)",
    )
    .action(async () => {
      requireMacos();
      const settings = await requireSettingsOrExit();
      const controller = new AbortController();
      process.once("SIGINT", () => controller.abort());
      process.once("SIGTERM", () => controller.abort());
      await runSupervisor({ settings, signal: controller.signal });
    });
}
