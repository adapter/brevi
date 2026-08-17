import type { AttachClientMessage, AttachServerMessage, ResumeRunResponse } from "@brevi/shared";
import { loadConfig } from "@brevi/orchestrator";
import type { Command } from "commander";
import pc from "picocolors";
import { WebSocket } from "ws";
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
        // No abort timeout here: rehydrating a retained sandbox can take a while.
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
      console.log(
        pc.dim(`Attaching to run ${runId} (${run.ticket.identifier}) on worker ${attach.workerName}...`),
      );

      const exitCode = await new Promise<number>((resolve) => {
        const socket = new WebSocket(`ws://localhost:${port}/ws/runs/${encodeURIComponent(runId)}/attach`);
        const stdin = process.stdin;
        const isTty = stdin.isTTY === true;

        // In raw mode Ctrl+C is a 0x03 byte on stdin rather than a signal, so
        // it travels to the remote session, which decides what it means. The
        // handler below only covers the non-tty case (piped stdin, where the
        // terminal still raises SIGINT): ignoring it keeps this process alive
        // long enough to release the sandbox, where Node's default SIGINT exit
        // would skip the /release below and leave a rehydrated VM running
        // until the reaper. SIGTERM targets this process alone, so it closes
        // the socket and lets the settle path run the release.
        const onSigint = (): void => {};
        const onSigterm = (): void => {
          socket.close();
        };
        process.on("SIGINT", onSigint);
        process.on("SIGTERM", onSigterm);

        const onStdinData = (chunk: string): void => {
          send({ type: "input", data: chunk });
        };
        const sendResize = (): void => {
          send({ type: "resize", cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 });
        };

        const settle = (code: number): void => {
          process.off("SIGINT", onSigint);
          process.off("SIGTERM", onSigterm);
          stdin.off("data", onStdinData);
          process.stdout.off("resize", sendResize);
          if (isTty) stdin.setRawMode(false);
          // stdin was resumed to read the session's keystrokes, and a flowing
          // stdin keeps the event loop referenced: without this the command
          // would print its detach line and then hang instead of exiting.
          stdin.pause();
          resolve(code);
        };

        const send = (message: AttachClientMessage): void => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
        };

        let opened = false;

        socket.on("open", () => {
          opened = true;
          if (isTty) stdin.setRawMode(true);
          stdin.setEncoding("utf8");
          stdin.on("data", onStdinData);
          stdin.resume();

          // No resize has arrived yet on a brand-new socket; sending one now
          // matches this terminal's real size instead of the server's default.
          sendResize();
          process.stdout.on("resize", sendResize);
        });

        socket.on("message", (raw) => {
          let message: AttachServerMessage;
          try {
            message = JSON.parse(String(raw)) as AttachServerMessage;
          } catch {
            return;
          }
          if (message.type === "data") {
            process.stdout.write(message.data);
          } else if (message.type === "exit") {
            settle(message.code);
          } else if (message.type === "error") {
            console.error(pc.red(`✖ ${message.message}`));
            settle(1);
          }
        });

        socket.on("close", () => {
          // A socket that never opened means the terminal bridge itself could
          // not be reached, which otherwise looks exactly like a session that
          // ended normally the moment it started.
          if (!opened) {
            console.error(pc.red(`✖ could not open the terminal bridge on port ${port}`));
            settle(1);
            return;
          }
          settle(0);
        });
        // "close" always follows "error" for a ws client socket, and the
        // handler above reports it; this only keeps the default 'error'
        // behavior from crashing the process on an unhandled event.
        socket.on("error", () => {});
      });

      // Stop the VM again; the disk stays until the retention window ends.
      await fetch(`http://localhost:${port}/api/runs/${encodeURIComponent(runId)}/release`, {
        method: "POST",
      }).catch(() => undefined);

      console.log(pc.dim("Detached; the sandbox stays resumable until its retention window ends."));
      process.exitCode = exitCode;
    });
}
