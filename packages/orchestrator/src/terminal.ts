import type { AttachClientMessage, AttachServerMessage } from "@brevi/shared";
import type { WebSocket } from "ws";
import type { AttachSession } from "./workers.js";
import type { Orchestrator } from "./scheduler.js";

/**
 * Bridges one dashboard web-terminal socket to a run's resume session. The
 * host never runs a PTY itself any more: a run's retained sandbox lives on
 * whichever worker executed it, so this is purely a byte relay over
 * `orchestrator.openRunAttach`, which reaches that worker's session over its
 * own `/ws/worker` socket. Lifetime still mirrors `brevi attach`: resumeRun's
 * eligibility checks on connect, releaseRun on disconnect, so the scheduler's
 * client refcount treats web and CLI sessions alike even though the worker
 * itself now owns the actual teardown (see Orchestrator.releaseRun).
 */
export function handleAttachSocket(socket: WebSocket, orchestrator: Orchestrator, runId: string): void {
  const send = (message: AttachServerMessage): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };

  let session: AttachSession | undefined;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    void orchestrator.releaseRun(runId).catch(() => undefined);
  };

  void (async () => {
    try {
      await orchestrator.resumeRun(runId);
    } catch (error) {
      send({ type: "error", message: error instanceof Error ? error.message : String(error) });
      socket.close();
      return;
    }
    if (socket.readyState !== socket.OPEN) {
      // The dashboard gave up while the eligibility checks ran.
      release();
      return;
    }

    // No resize has arrived yet on a brand-new socket; 80x24 matches the
    // PTY default `brevi attach` used to spawn locally, so the first frame
    // isn't garbled before the client's real terminal size lands.
    const opened = orchestrator.openRunAttach(runId, {
      cols: 80,
      rows: 24,
      onData: (data: string) => send({ type: "data", data }),
      onExit: (code: number) => {
        session = undefined; // teardown on socket close must not re-close an exited session
        send({ type: "exit", code });
        release();
        socket.close();
      },
      onError: (message: string) => {
        // The worker reports an error only when the session could not run at
        // all (no retained disk, a boot failure), and the registry drops the
        // session with it, so there is nothing left to type into: end the
        // socket rather than leave the terminal open against a dead relay.
        session = undefined;
        send({ type: "error", message });
        release();
        socket.close();
      },
    });
    if (!opened) {
      send({ type: "error", message: "the worker holding this run's sandbox isn't connected right now" });
      release();
      socket.close();
      return;
    }
    if (socket.readyState !== socket.OPEN) {
      // The dashboard gave up while the relay was opening.
      opened.close();
      release();
      return;
    }
    session = opened;
  })();

  socket.on("message", (raw) => {
    let message: AttachClientMessage;
    try {
      message = JSON.parse(String(raw)) as AttachClientMessage;
    } catch {
      return;
    }
    if (message.type === "input") session?.input(message.data);
    else if (message.type === "resize" && message.cols > 0 && message.rows > 0) {
      session?.resize(Math.floor(message.cols), Math.floor(message.rows));
    }
  });

  const teardown = (): void => {
    session?.close();
    session = undefined;
    release();
  };
  socket.on("close", teardown);
  socket.on("error", teardown);
}
