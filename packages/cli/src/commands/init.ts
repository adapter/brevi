import type { Command } from "commander";
import pc from "picocolors";

/** Hidden so old muscle memory gets a pointer, not "too many arguments". */
export function registerInitCommand(program: Command): void {
  program
    .command("init", { hidden: true })
    .description("Removed: first launch of brevi writes the config; finish setup in the dashboard")
    .action(() => {
      console.error(pc.yellow("`brevi init` has been removed."));
      console.error(
        pc.dim("  Run `npx @brevi/cli` and finish setup in the dashboard that opens."),
      );
      process.exit(1);
    });
}
