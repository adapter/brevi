import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type {
  BreviConfig,
  ClientMessage,
  HealthResponse,
  Run,
  RunEvent,
  ServerMessage,
  Ticket,
} from "@brevi/shared";
import { api, wsUrl } from "./api";

export type Connection = "connecting" | "live" | "reconnecting" | "offline";

/** Keep the console bounded on very long runs. */
const MAX_EVENTS = 4000;

interface State {
  conn: Connection;
  runs: Run[];
  tickets: Ticket[];
  config: BreviConfig | null;
  health: HealthResponse | null;
  events: Record<string, RunEvent[] | undefined>;
  loadedRuns: Record<string, true | undefined>;
  busy: Record<string, true | undefined>;
  notice: string | null;
  selectedRunId: string | null;
  /** True once runs/tickets have arrived from either transport. */
  loaded: boolean;
}

type Action =
  | { t: "conn"; conn: Connection }
  | { t: "hello"; runs: Run[]; tickets: Ticket[]; config: BreviConfig }
  | { t: "config"; config: BreviConfig }
  | { t: "tickets"; tickets: Ticket[] }
  | { t: "run"; run: Run }
  | { t: "event"; event: RunEvent }
  | { t: "seed"; runs?: Run[]; tickets?: Ticket[]; health?: HealthResponse }
  | { t: "history"; runId: string; events: RunEvent[] }
  | { t: "busy"; key: string; on: boolean }
  | { t: "notice"; notice: string | null }
  | { t: "select"; runId: string | null };

const initial: State = {
  conn: "connecting",
  runs: [],
  tickets: [],
  config: null,
  health: null,
  events: {},
  loadedRuns: {},
  busy: {},
  notice: null,
  selectedRunId: null,
  loaded: false,
};

function byNewest(a: Run, b: Run): number {
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}

function upsert(runs: Run[], run: Run): Run[] {
  const next = runs.some((r) => r.id === run.id)
    ? runs.map((r) => (r.id === run.id ? run : r))
    : [run, ...runs];
  return next.sort(byNewest);
}

function append(list: RunEvent[] | undefined, event: RunEvent): RunEvent[] {
  const next = [...(list ?? []), event];
  return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
}

function reducer(state: State, action: Action): State {
  switch (action.t) {
    case "conn":
      return { ...state, conn: action.conn };
    case "hello":
      return {
        ...state,
        runs: [...action.runs].sort(byNewest),
        tickets: action.tickets,
        config: action.config,
        loaded: true,
      };
    case "config":
      return { ...state, config: action.config };
    case "tickets":
      return { ...state, tickets: action.tickets };
    case "run": {
      const runs = upsert(state.runs, action.run);
      return { ...state, runs, loaded: true };
    }
    case "event": {
      const { runId } = action.event;
      // Only accumulate for runs whose console has been opened at least once.
      if (!state.loadedRuns[runId] && state.selectedRunId !== runId) return state;
      return {
        ...state,
        events: { ...state.events, [runId]: append(state.events[runId], action.event) },
      };
    }
    case "seed": {
      const runs = action.runs ? [...action.runs].sort(byNewest) : state.runs;
      return {
        ...state,
        runs,
        tickets: action.tickets ?? state.tickets,
        health: action.health ?? state.health,
        loaded: state.loaded || action.runs !== undefined || action.tickets !== undefined,
      };
    }
    case "history": {
      // Live events may have landed while the history request was in flight.
      // Cut on the newest timestamp in the history, not the last entry, so that
      // out-of-order writes and a second open of the same run cannot duplicate.
      const live = state.events[action.runId] ?? [];
      let cut = 0;
      for (const e of action.events) cut = Math.max(cut, Date.parse(e.ts));
      const tail = live.filter((e) => Date.parse(e.ts) > cut);
      return {
        ...state,
        events: { ...state.events, [action.runId]: [...action.events, ...tail] },
        loadedRuns: { ...state.loadedRuns, [action.runId]: true },
      };
    }
    case "busy": {
      const busy = { ...state.busy };
      if (action.on) busy[action.key] = true;
      else delete busy[action.key];
      return { ...state, busy };
    }
    case "notice":
      return { ...state, notice: action.notice };
    case "select":
      return { ...state, selectedRunId: action.runId };
    default:
      return state;
  }
}

function message(raw: string): ServerMessage | null {
  try {
    return JSON.parse(raw) as ServerMessage;
  } catch {
    return null;
  }
}

export function useOrchestrator() {
  const [state, dispatch] = useReducer(reducer, initial);
  const socket = useRef<WebSocket | null>(null);
  const selected = useRef<string | null>(null);
  selected.current = state.selectedRunId;

  const send = useCallback((msg: ClientMessage) => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  // --- WebSocket with backoff ------------------------------------------------
  useEffect(() => {
    let disposed = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (disposed) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl());
      } catch {
        retry();
        return;
      }
      socket.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        attempts = 0;
        dispatch({ t: "conn", conn: "live" });
        if (selected.current) send({ type: "subscribe", runId: selected.current });
      };

      ws.onmessage = (ev) => {
        if (disposed || typeof ev.data !== "string") return;
        const msg = message(ev.data);
        if (!msg) return;
        switch (msg.type) {
          case "hello":
            dispatch({ t: "hello", runs: msg.runs, tickets: msg.tickets, config: msg.config });
            break;
          case "config":
            dispatch({ t: "config", config: msg.config });
            break;
          case "tickets":
            dispatch({ t: "tickets", tickets: msg.tickets });
            break;
          case "run-updated":
            dispatch({ t: "run", run: msg.run });
            break;
          case "run-event":
            dispatch({ t: "event", event: msg.event });
            break;
          default:
            break;
        }
      };

      ws.onerror = () => ws.close();
      ws.onclose = () => {
        if (disposed || socket.current !== ws) return;
        socket.current = null;
        retry();
      };
    };

    const retry = () => {
      if (disposed) return;
      attempts += 1;
      dispatch({ t: "conn", conn: attempts >= 2 ? "offline" : "reconnecting" });
      const delay = Math.min(15_000, 400 * 2 ** (attempts - 1)) + Math.random() * 250;
      timer = setTimeout(connect, delay);
    };

    connect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      const ws = socket.current;
      socket.current = null;
      ws?.close();
    };
  }, [send]);

  // --- REST fallback ---------------------------------------------------------
  const refresh = useCallback(async () => {
    const [runs, tickets, health] = await Promise.all([
      api.runs().catch(() => undefined),
      api.tickets().catch(() => undefined),
      api.health().catch(() => undefined),
    ]);
    if (runs || tickets || health) dispatch({ t: "seed", runs, tickets, health });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const degraded = state.conn !== "live";
  useEffect(() => {
    if (!degraded) return;
    const id = setInterval(() => void refresh(), 6000);
    return () => clearInterval(id);
  }, [degraded, refresh]);

  // --- Actions ---------------------------------------------------------------
  const openRun = useCallback(
    (runId: string | null) => {
      const previous = selected.current;
      if (previous && previous !== runId) send({ type: "unsubscribe", runId: previous });
      dispatch({ t: "select", runId });
      if (!runId) return;
      send({ type: "subscribe", runId });
      api
        .events(runId)
        .then((events) => dispatch({ t: "history", runId, events }))
        .catch(() => dispatch({ t: "history", runId, events: [] }));
    },
    [send],
  );

  const runTicket = useCallback(
    async (ticketId: string) => {
      dispatch({ t: "busy", key: ticketId, on: true });
      dispatch({ t: "notice", notice: null });
      try {
        const run = await api.runTicket(ticketId);
        dispatch({ t: "run", run });
        return run;
      } catch (err) {
        dispatch({ t: "notice", notice: `Could not queue the ticket. ${errorText(err)}` });
        return undefined;
      } finally {
        dispatch({ t: "busy", key: ticketId, on: false });
      }
    },
    [],
  );

  const cancelRun = useCallback(async (runId: string) => {
    dispatch({ t: "busy", key: runId, on: true });
    dispatch({ t: "notice", notice: null });
    try {
      dispatch({ t: "run", run: await api.cancelRun(runId) });
    } catch (err) {
      dispatch({ t: "notice", notice: `Could not cancel the run. ${errorText(err)}` });
    } finally {
      dispatch({ t: "busy", key: runId, on: false });
    }
  }, []);

  const dismissNotice = useCallback(() => dispatch({ t: "notice", notice: null }), []);

  /** Adopt a redacted config returned by a settings mutation. */
  const applyConfig = useCallback(
    (config: BreviConfig) => dispatch({ t: "config", config }),
    [],
  );

  const selectedRun = useMemo(
    () => state.runs.find((r) => r.id === state.selectedRunId),
    [state.runs, state.selectedRunId],
  );

  return {
    ...state,
    selectedRun,
    events: state.events,
    openRun,
    runTicket,
    cancelRun,
    dismissNotice,
    applyConfig,
  };
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "The orchestrator did not respond.";
}
