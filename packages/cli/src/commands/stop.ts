import type { Command } from "commander";
import pc from "picocolors";
import { findRunningServer, stopServer } from "../lib/stop.js";

export function registerStopCommand(program: Command): void {
  program
    .command("stop")
    .description("Stop the running brevi orchestrator")
    .action(async () => {
      const server = await findRunningServer();
      if (server === null) {
        console.log(pc.yellow("✖ brevi is not running."));
        console.log(pc.dim("  Start it with `npx @brevi/cli` or `npx @brevi/cli start`."));
        process.exit(1);
      }

      if (!(await stopServer(server.pid))) process.exit(1);
      console.log(pc.green(`✔ Stopped brevi (pid ${server.pid}).`));

      // The supervisor treats this SIGTERM exit as a deliberate outside stop
      // and goes idle instead of respawning, so the stop is real, but the app
      // itself is still around and can bring the orchestrator back any time.
      if (server.desktopSupervisorPid !== null) {
        console.log(
          pc.dim(
            "  The brevi desktop app is still running in the menu bar and will not restart the orchestrator by itself; use \"Start Orchestrator\" there, or `brevi start`.",
          ),
        );
      }
    });
}
