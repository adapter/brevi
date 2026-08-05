#!/usr/bin/env node
import { Command } from "commander";
import { registerDefaultCommand } from "./commands/default.js";
import { registerInitCommand } from "./commands/init.js";
import { registerStartCommand } from "./commands/start.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerUiCommand } from "./commands/ui.js";
import { readPackageVersion } from "./lib/version.js";

const program = new Command();

program
  .name("brevi")
  .description(
    "Local sandbox + orchestrator for coding agents: watches Linear, runs brevi-labeled tickets, opens PRs. Run with no arguments to set up (first launch only), start, and open the dashboard.",
  )
  .version(readPackageVersion());

registerDefaultCommand(program);
registerInitCommand(program);
registerUiCommand(program);
registerStartCommand(program);
registerStatusCommand(program);

await program.parseAsync(process.argv);
