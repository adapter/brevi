import { spawn, type IPty } from "@lydell/node-pty";
import type { AttachClientMessage, AttachServerMessage, RunAttachInfo } from "@brevi/shared";
import type { WebSocket } from "ws";
import type { Orchestrator } from "./scheduler.js";

/**
 * Bridges one dashboard web-terminal socket to a PTY running a run's resume
 * session. The PTY runs on this host in both cases: the process provider's
 * resume script executes directly, a Firecracker sandbox is reached with
 * `ssh -t` (the PTY makes ssh propagate terminal size and resizes). Lifetime
 * mirrors `brevi attach`: resumeRun on connect, releaseRun on disconnect, so
 * the scheduler's client refcount treats web and CLI sessions alike.
 */
export function handleAttachSocket(socket: WebSocket, orchestrator: Orchestrator, runId: string): void {
  const send = (message: AttachServerMessage): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };

  let pty: IPty | undefined;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    void orchestrator.releaseRun(runId).catch(() => undefined);
  };

  void (async () => {
    let attach: RunAttachInfo;
    try {
      ({ attach } = await orchestrator.resumeRun(runId));
    } catch (error) {
      send({ type: "error", message: error instanceof Error ? error.message : String(error) });
      socket.close();
      return;
    }
    if (socket.readyState !== socket.OPEN) {
      // The dashboard gave up while the sandbox booted.
      release();
      return;
    }

    const [file, args] =
      attach.kind === "local"
        ? ["/bin/sh", [attach.scriptPath]]
        : [
            "ssh",
            [
              // -t forces the remote pty for the interactive agent; the local
              // pty this spawn provides is what lets ssh forward resizes.
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
          ];
    try {
      pty = spawn(file, args, { name: "xterm-256color", cols: 80, rows: 24 });
    } catch (error) {
      send({ type: "error", message: error instanceof Error ? error.message : String(error) });
      release();
      socket.close();
      return;
    }

    pty.onData((data) => send({ type: "data", data }));
    pty.onExit(({ exitCode }) => {
      pty = undefined; // teardown on socket close must not kill an exited pty
      send({ type: "exit", code: exitCode });
      release();
      socket.close();
    });
  })();

  socket.on("message", (raw) => {
    let message: AttachClientMessage;
    try {
      message = JSON.parse(String(raw)) as AttachClientMessage;
    } catch {
      return;
    }
    if (message.type === "input") pty?.write(message.data);
    else if (message.type === "resize" && message.cols > 0 && message.rows > 0) {
      pty?.resize(Math.floor(message.cols), Math.floor(message.rows));
    }
  });

  const teardown = (): void => {
    pty?.kill();
    pty = undefined;
    release();
  };
  socket.on("close", teardown);
  socket.on("error", teardown);
}
