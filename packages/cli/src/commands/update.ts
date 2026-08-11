import { spawn } from "node:child_process";
import { waitForPidFile } from "@brevi/orchestrator/pid";
import type { Command } from "commander";
import pc from "picocolors";
import { findRunningServer, stopServer } from "../lib/stop.js";
import {
  CHANGELOG_URL,
  PACKAGE_NAME,
  compareVersions,
  detectInstallMethod,
  fetchLatestVersion,
} from "../lib/update.js";
import { errorMessage } from "../lib/util.js";
import { readPackageVersion } from "../lib/version.js";

/** How long a restarted server gets to come up and write its pid file. */
const RESTART_TIMEOUT_MS = 15_000;

export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .alias("upgrade")
    .description(`Update ${PACKAGE_NAME} to the latest version published on npm`)
    .option("--check", "only report whether a newer version exists, without installing")
    .action(async (options: { check?: boolean }) => {
      await runUpdate(Boolean(options.check));
    });
}

async function runUpdate(checkOnly: boolean): Promise<void> {
  const current = readPackageVersion();

  let latest: string;
  try {
    latest = await fetchLatestVersion();
  } catch (err) {
    console.error(pc.red(`✖ Could not reach the npm registry: ${errorMessage(err)}`));
    process.exit(1);
  }

  if (compareVersions(current, latest) >= 0) {
    console.log(pc.green(`✔ ${PACKAGE_NAME} is up to date (${pc.bold(current)})`));
    return;
  }

  console.log(
    pc.yellow(`! Update available: ${pc.bold(current)} → ${pc.bold(latest)}`),
  );
  // brevi has breaking changes between releases, so always point at the changelog.
  console.log(pc.dim(`  What changed: ${CHANGELOG_URL}`));

  if (checkOnly) {
    console.log(pc.dim("  Run `brevi update` to install it."));
    process.exit(1);
  }

  const method = detectInstallMethod();

  if (method.kind === "runner") {
    console.log(`\n${PACKAGE_NAME} is running through ${pc.bold(method.runner)}, so there is nothing installed to update.`);
    console.log(pc.dim(`  Run \`npx ${PACKAGE_NAME}@latest <command>\` (or the ${method.runner} equivalent) to use ${latest},`));
    console.log(pc.dim(`  or install it globally: \`npm install -g ${PACKAGE_NAME}\`.`));
    return;
  }

  if (method.kind === "unknown") {
    console.error(pc.red(`\n✖ Couldn't work out how ${PACKAGE_NAME} was installed (not under node_modules).`));
    console.error(pc.dim(`  Update it with the package manager you installed it with, e.g. \`npm install -g ${PACKAGE_NAME}@${latest}\`.`));
    process.exit(1);
  }

  const args = [...method.installArgs, `${PACKAGE_NAME}@${latest}`];
  const pretty = `${method.manager} ${args.join(" ")}`;
  console.log(`\nDetected a global ${pc.bold(method.manager)} install; running ${pc.cyan(pretty)}`);

  const code = await runInstall(method.manager, args);
  if (code !== 0) {
    console.error(pc.red(`✖ \`${pretty}\` exited with code ${code}.`));
    console.error(pc.dim("  If that was a permissions error, retry with elevated permissions (e.g. `sudo`)."));
    process.exit(1);
  }

  console.log(pc.green(`\n✔ Updated ${PACKAGE_NAME} ${current} → ${pc.bold(latest)}`));
  console.log(pc.dim(`  Changelog: ${CHANGELOG_URL}`));

  await restartIfRunning(latest);
}

/**
 * Restarts a running server so the freshly installed version takes effect:
 * graceful stop (same escalation as `brevi stop`), then a detached headless
 * `brevi start` from our own bin path. The install replaced its contents in
 * place, so the new process runs the new version. No-op when nothing is
 * running.
 *
 * A desktop-supervised server is left alone entirely: stopping it would just
 * have the desktop app's supervisor race our detached replacement (it treats
 * the exit as a crash and restarts its own bundled build), and updating the
 * npm CLI never touches that bundled copy anyway.
 */
async function restartIfRunning(latest: string): Promise<void> {
  const server = await findRunningServer();
  if (server === null) return;

  if (server.desktopSupervisorPid !== null) {
    console.log(`\nbrevi is running (pid ${server.pid}) under the brevi desktop app; it was left running as is.`);
    console.log(
      pc.dim(
        "  Updating the npm CLI does not update the desktop app's bundled copy; quit and reopen the desktop app (or update the app itself) to pick up this change.",
      ),
    );
    return;
  }

  console.log(`\nbrevi is running (pid ${server.pid}); restarting it on ${pc.bold(latest)}...`);
  if (!(await stopServer(server.pid))) {
    console.error(pc.red("✖ Could not stop the running instance; restart it manually with `brevi start`."));
    process.exit(1);
  }

  const entry = process.argv[1];
  if (!entry) {
    console.error(pc.red("✖ Could not work out how to relaunch brevi; start it with `brevi start`."));
    process.exit(1);
  }

  // Detached with no stdio so the server outlives this command, like a
  // freshly run `brevi start` in another terminal.
  const child = spawn(process.execPath, [entry, "start"], { detached: true, stdio: "ignore" });
  child.on("error", (err) => {
    console.error(pc.red(`✖ Could not start the new version: ${errorMessage(err)}`));
  });
  child.unref();

  const newPid = await waitForPidFile(RESTART_TIMEOUT_MS);
  if (newPid === null) {
    console.log(pc.yellow("! Started the new version but couldn't confirm it's up; check `brevi status`."));
    return;
  }
  console.log(pc.green(`✔ Restarted brevi on ${latest} (pid ${newPid}).`));
}

/** Runs the package manager with inherited stdio, resolving to its exit code. */
function runInstall(command: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", (err) => {
      console.error(pc.red(`✖ Could not run ${command}: ${errorMessage(err)}`));
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}
