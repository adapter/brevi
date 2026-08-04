import type { Command } from "commander";
import { runServer } from "../lib/serve.js";

export function registerStartCommand(program: Command): void {
  program
    .command("start")
    .description("Start the orchestrator headlessly, without opening a browser")
    .action(async () => {
      await runServer({ openBrowser: false });
    });
}
