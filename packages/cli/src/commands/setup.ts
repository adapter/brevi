import { spawn } from "node:child_process";
import { collectBwrapProblems, resolveBinary } from "@brevi/sandbox";
import { confirm, intro, log, outro, spinner } from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { errorMessage, exitOnCancel } from "../lib/util.js";

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Install bubblewrap and passt so this Linux host can execute isolated runs")
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

/** Provisions bubblewrap and passt on this Linux host. Returns true when the sandbox is ready. */
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

  const bwrapBin = await resolveBinary("bwrap");
  if (bwrapBin) log.success(`bwrap: ${bwrapBin}`);
  const pastaBin = await resolveBinary("pasta");
  if (pastaBin) log.success(`pasta: ${pastaBin}`);
  const missing = [...(bwrapBin ? [] : ["bubblewrap"]), ...(pastaBin ? [] : ["passt"])];
  if (missing.length > 0) {
    const label = missing.join(" and ");
    const install = assumeYes
      ? true
      : exitOnCancel(
          await confirm({
            message: `${missing.length === 1 ? `${label} is` : `${label} are`} not installed. Install with apt?`,
            initialValue: true,
          }),
        );
    if (!install) {
      log.warn(`Skipped; this machine cannot execute runs until ${label} ${missing.length === 1 ? "is" : "are"} installed.`);
    } else {
      const s = spinner();
      s.start(`Installing ${label}`);
      const code = await runSudo(["apt-get", "install", "-y", ...missing]);
      if (code === 0) s.stop(`Installed ${label}`);
      else {
        s.error(`apt-get install ${missing.join(" ")} failed`);
        log.warn(`Install ${missing.length === 1 ? "it" : "them"} yourself: sudo apt-get install ${missing.join(" ")}`);
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
