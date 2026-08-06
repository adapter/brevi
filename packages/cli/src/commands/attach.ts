import { spawn } from "node:child_process";
import type { ResumeRunResponse } from "@brevi/shared";
import { loadConfig } from "@brevi/orchestrator";
import type { Command } from "commander";
import pc from "picocolors";
import { errorMessage } from "../lib/util.js";

export function registerAttachCommand(program: Command): void {
  program
    .command("attach <runId>")
    .description("Resume a run's agent conversation inside its retained sandbox")
    .action(async (runId: string) => {
      const config = await loadConfig().catch((err: unknown) => {
        console.error(pc.red(`✖ ${errorMessage(err)}`));
        console.error(pc.dim("  Run `npx @brevi/cli init` to create one."));
        process.exit(1);
      });

      const port = config.server.port;
      const url = `http://localhost:${port}/api/runs/${encodeURIComponent(runId)}/resume`;

      let res: Response;
      try {
        // No abort timeout here: booting a Firecracker microVM can take a while.
        res = await fetch(url, { method: "POST", headers: { Accept: "application/json" } });
      } catch {
        console.log(pc.yellow(`✖ brevi is not running on port ${port}`));
        console.log(pc.dim("  Start it with `npx @brevi/cli` or `npx @brevi/cli start`."));
        process.exit(1);
      }

      if (!res.ok) {
        const message = await res
          .json()
          .then((body: unknown) => (body as { error?: string }).error)
          .catch(() => undefined);
        console.error(pc.red(`✖ ${message ?? `HTTP ${res.status}`}`));
        process.exit(1);
      }

      const { run, attach } = (await res.json()) as ResumeRunResponse;
      console.log(pc.dim(`Attaching to run ${runId} (${run.ticket.identifier})...`));

      const exitCode = await new Promise<number>((resolve) => {
        // Ctrl+C goes to the whole foreground process group: the interactive
        // session receives it directly and decides what it means. The wrapper
        // ignores it so it survives to release the sandbox once the child
        // exits; without this, Node's default SIGINT exit would skip the
        // /release below and leave a rehydrated VM running until the reaper.
        // SIGTERM targets the wrapper alone, so it is forwarded to the child;
        // the exit handler then resolves and the release still runs.
        const onSigint = (): void => {};
        const onSigterm = (): void => {
          child.kill("SIGTERM");
        };
        process.on("SIGINT", onSigint);
        process.on("SIGTERM", onSigterm);
        const settle = (code: number): void => {
          process.off("SIGINT", onSigint);
          process.off("SIGTERM", onSigterm);
          resolve(code);
        };

        const child =
          attach.kind === "local"
            ? spawn("/bin/sh", [attach.scriptPath], { stdio: "inherit" })
            : spawn(
                "ssh",
                [
                  // -t forces a tty for the interactive agent.
                  "-t",
                  "-i",
                  attach.keyPath,
                  "-o",
                  "StrictHostKeyChecking=no",
                  "-o",
                  "UserKnownHostsFile=/dev/null",
                  "-o",
                  "LogLevel=ERROR",
                  `${attach.user}@${attach.host}`,
                  attach.scriptPath,
                ],
                { stdio: "inherit" },
              );

        child.on("error", (err) => {
          console.error(pc.red(`✖ ${errorMessage(err)}`));
          settle(1);
        });
        child.on("exit", (code) => settle(code ?? 0));
      });

      // Stop the VM again; the disk stays until the retention window ends.
      await fetch(`http://localhost:${port}/api/runs/${encodeURIComponent(runId)}/release`, {
        method: "POST",
      }).catch(() => undefined);

      console.log(pc.dim("Detached; the sandbox stays resumable until its retention window ends."));
      process.exitCode = exitCode;
    });
}
