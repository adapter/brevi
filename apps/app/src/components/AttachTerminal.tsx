import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as Xterm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { AttachClientMessage, AttachServerMessage } from "@brevi/shared";
import { Button } from "@/components/ui/button";
import { attachWsUrl } from "../lib/api";
import { clock, elapsed } from "../lib/format";
import { Stop } from "./Icons";

type SessionState =
  | { phase: "connecting" }
  | { phase: "connected" }
  | { phase: "ended"; detail: string }
  | { phase: "error"; detail: string };

/**
 * The run's agent conversation, resumed inside its retained sandbox and
 * rendered as a live terminal. The sandbox boots server-side and the session
 * travels over a WebSocket, so this works no matter which machine the
 * orchestrator runs on. Closing (or leaving the page) detaches: the server
 * releases the sandbox once its last client is gone.
 */
export function AttachTerminal({
  runId,
  retainedUntil,
  now,
  onClose,
}: {
  runId: string;
  retainedUntil: string;
  now: number;
  onClose: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<SessionState>({ phase: "connecting" });
  const retainedMs = Date.parse(retainedUntil);

  useEffect(() => {
    const el = host.current;
    if (!el) return;

    // Xterm needs concrete colors; lift them off the themed container so the
    // terminal follows the palette without branching on light/dark here.
    const style = getComputedStyle(el);
    const term = new Xterm({
      fontFamily: style.fontFamily,
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      theme: { background: style.backgroundColor, foreground: style.color, cursor: style.color },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    const socket = new WebSocket(attachWsUrl(runId));
    const send = (message: AttachClientMessage): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };

    socket.onopen = () => {
      setState({ phase: "connected" });
      send({ type: "resize", cols: term.cols, rows: term.rows });
      term.focus();
    };
    socket.onmessage = (event: MessageEvent<string>) => {
      let message: AttachServerMessage;
      try {
        message = JSON.parse(event.data) as AttachServerMessage;
      } catch {
        return;
      }
      if (message.type === "data") term.write(message.data);
      else if (message.type === "exit") {
        setState({ phase: "ended", detail: `session ended (exit ${message.code})` });
      } else setState({ phase: "error", detail: message.message });
    };
    socket.onclose = () => {
      setState((prev) =>
        prev.phase === "ended" || prev.phase === "error"
          ? prev
          : { phase: "ended", detail: "disconnected" },
      );
    };

    const inputSub = term.onData((data) => send({ type: "input", data }));
    const observer = new ResizeObserver(() => {
      fit.fit();
      send({ type: "resize", cols: term.cols, rows: term.rows });
    });
    observer.observe(el);

    return () => {
      observer.disconnect();
      inputSub.dispose();
      socket.close();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const status =
    state.phase === "connecting"
      ? "Booting sandbox..."
      : state.phase === "connected"
        ? "Connected"
        : state.detail;

  return (
    <div className="flex h-[calc(100svh-8.5rem)] flex-col overflow-hidden rounded-[5px] border border-ink-700/70">
      <div className="flex h-9 shrink-0 items-center gap-2.5 border-b border-ink-700/70 bg-ink-800/60 px-3">
        <span className="plate text-haze-200">Sandbox terminal</span>
        <span
          className={`font-mono text-[11px] ${state.phase === "error" ? "text-rust-400" : "text-haze-600"}`}
        >
          {status}
        </span>
        <span className="ml-auto hidden font-mono text-[11px] text-haze-700 sm:inline">
          available until {clock(retainedUntil)} (in {elapsed(Math.max(0, retainedMs - now))})
        </span>
        <Button variant="outline" size="plate" onClick={onClose}>
          <Stop className="size-3" />
          {state.phase === "connected" ? "Disconnect" : "Close"}
        </Button>
      </div>
      {/* font-mono matters: the xterm theme lifts this container's computed
          font, and a proportional face breaks the terminal's cell grid. */}
      <div ref={host} className="min-h-0 flex-1 bg-ink-900 p-2 font-mono text-haze-200" />
    </div>
  );
}
