import type { Command } from "commander";
import { runServer } from "../lib/serve.js";

/**
 * The bare `brevi` invocation: on a fresh machine it writes schema defaults,
 * provisions Firecracker on Linux, starts the orchestrator, and opens the
 * dashboard at /setup. Connections and the sandbox provider are chosen there.
 */
export function registerDefaultCommand(program: Command): void {
  program.action(async () => {
    await runServer({ openBrowser: true });
  });
}

export async function runDefaultFlow(): Promise<void> {
  await runServer({ openBrowser: true });
}
