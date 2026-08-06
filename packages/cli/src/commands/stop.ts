import type { Command } from "commander";
import pc from "picocolors";
import { findRunningServer, stopServer } from "../lib/stop.js";

export function registerStopCommand(program: Command): void {
  program
    .command("stop")
    .description("Stop the running brevi orchestrator")
    .action(async () => {
      const pid = await findRunningServer();
      if (pid === null) {
        console.log(pc.yellow("✖ brevi is not running."));
        console.log(pc.dim("  Start it with `npx @brevi/cli` or `npx @brevi/cli start`."));
        process.exit(1);
      }

      if (!(await stopServer(pid))) process.exit(1);
      console.log(pc.green(`✔ Stopped brevi (pid ${pid}).`));
    });
}
