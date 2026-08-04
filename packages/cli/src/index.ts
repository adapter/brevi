#!/usr/bin/env node
import { Command } from "commander";
import { registerInitCommand } from "./commands/init.js";
import { registerStartCommand } from "./commands/start.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerUiCommand } from "./commands/ui.js";
import { readPackageVersion } from "./lib/version.js";

const program = new Command();

program
  .name("brevi")
  .description(
    "Local sandbox + orchestrator for coding agents: watches Linear, runs @brevi-tagged tickets, opens PRs.",
  )
  .version(readPackageVersion());

registerInitCommand(program);
registerUiCommand(program);
registerStartCommand(program);
registerStatusCommand(program);

await program.parseAsync(process.argv);
