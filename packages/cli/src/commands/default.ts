import { existsSync } from "node:fs";
import { CONFIG_PATH } from "@brevi/shared";
import type { Command } from "commander";
import pc from "picocolors";
import { runServer } from "../lib/serve.js";
import { runInit } from "./init.js";

/**
 * The bare `brevi` invocation: on a fresh machine (no config yet) it runs
 * the init flow first, then starts the orchestrator and opens the dashboard.
 */
export function registerDefaultCommand(program: Command): void {
  program.action(async () => {
    await runDefaultFlow();
  });
}

export async function runDefaultFlow(): Promise<void> {
  if (!existsSync(CONFIG_PATH)) {
    // First-run setup needs a terminal to prompt in; never hang in CI/scripts.
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error(pc.red(`✖ No config found at ${CONFIG_PATH}.`));
      console.error(
        pc.dim(
          "  First-run setup is interactive and this terminal is not. Run `npx @brevi/cli init` from an interactive terminal first.",
        ),
      );
      process.exit(1);
    }
    const saved = await runInit({ firstRun: true });
    if (!saved) return;
  }
  await runServer({ openBrowser: true });
}
