#!/usr/bin/env node
import { Command } from "commander";
import { registerAttachCommand } from "./commands/attach.js";
import { registerDefaultCommand } from "./commands/default.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerInitCommand } from "./commands/init.js";
import { registerSetupCommand } from "./commands/setup.js";
import { registerStartCommand } from "./commands/start.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerStopCommand } from "./commands/stop.js";
import { registerUiCommand } from "./commands/ui.js";
import { registerUpdateCommand } from "./commands/update.js";
import { registerWorkerCommand } from "./commands/worker.js";
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
registerSetupCommand(program);
registerUiCommand(program);
registerStartCommand(program);
registerStopCommand(program);
registerAttachCommand(program);
registerStatusCommand(program);
registerDoctorCommand(program);
registerWorkerCommand(program);
registerUpdateCommand(program);

await program.parseAsync(process.argv);
