import { spawn } from "node:child_process";
import { collectBwrapProblems, resolveBinary } from "@brevi/sandbox";
import { confirm, intro, log, outro, spinner } from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { errorMessage, exitOnCancel } from "../lib/util.js";

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Install bubblewrap so this Linux host can execute isolated runs")
    .option("-y, --yes", "install missing packages without prompting")
    .action(async (options: { yes?: boolean }) => {
      try {
        const ready = await runSetup({ standalone: true, assumeYes: options.yes === true });
        process.exit(ready ? 0 : 1);
      } catch (err) {
        log.error(errorMessage(err));
        process.exit(1);
      }
    });
}

export interface RunSetupOptions {
  /** When false, skip the intro/outro so init can embed this flow. */
  standalone?: boolean;
  assumeYes?: boolean;
}

/** Provisions bubblewrap on this Linux host. Returns true when bwrap is ready. */
export async function runSetup(options: RunSetupOptions = {}): Promise<boolean> {
  const standalone = options.standalone !== false;
  const assumeYes = options.assumeYes === true;
  if (standalone) intro(pc.bgCyan(pc.black(" brevi setup ")));

  if (process.platform !== "linux") {
    log.warn(
      `bwrap sandboxes need Linux (this host is ${process.platform}). This machine can schedule runs; enroll a Linux worker to execute them.`,
    );
    if (standalone) outro("Nothing to set up on this host.");
    return false;
  }

  const existing = await resolveBinary("bwrap");
  if (existing) {
    log.success(`bwrap: ${existing}`);
  } else {
    const install = assumeYes
      ? true
      : exitOnCancel(
          await confirm({
            message: "bwrap is not on PATH. Install bubblewrap with apt?",
            initialValue: true,
          }),
        );
    if (!install) {
      log.warn("Skipped; this machine cannot execute runs until bubblewrap is installed.");
    } else {
      const s = spinner();
      s.start("Installing bubblewrap");
      const code = await runSudo(["apt-get", "install", "-y", "bubblewrap"]);
      if (code === 0) s.stop("Installed bubblewrap");
      else {
        s.error("apt-get install bubblewrap failed");
        log.warn("Install it yourself: sudo apt-get install bubblewrap");
      }
    }
  }

  const problems = await collectBwrapProblems();
  if (problems.length === 0) {
    log.success("Sandbox ready (bwrap).");
    if (standalone) outro("This machine can execute isolated runs.");
    return true;
  }

  for (const problem of problems) log.error(problem);
  if (standalone) outro("Fix the problems above, then re-run brevi setup.");
  return false;
}

function runSudo(argv: string[]): Promise<number> {
  log.info(`$ sudo ${argv.join(" ")}`);
  return new Promise((resolve) => {
    const child = spawn("sudo", argv, { stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}
