import type { Command } from "commander";
import pc from "picocolors";
import { runDefaultFlow } from "./default.js";

/** Hidden, deprecated alias for the bare `brevi` invocation. */
export function registerUiCommand(program: Command): void {
  program
    .command("ui", { hidden: true })
    .description(
      "(deprecated) Start the orchestrator and open the dashboard; run `brevi` instead",
    )
    .action(async () => {
      console.error(
        pc.yellow(
          "`brevi ui` is deprecated and will be removed; running `brevi` with no arguments does the same thing.",
        ),
      );
      await runDefaultFlow();
    });
}
