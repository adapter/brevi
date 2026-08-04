import type { Command } from "commander";
import { runServer } from "../lib/serve.js";

export function registerUiCommand(program: Command): void {
  program
    .command("ui")
    .description("Start the orchestrator and open the dashboard in your browser")
    .action(async () => {
      await runServer({ openBrowser: true });
    });
}
