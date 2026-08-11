import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type {
  BreviConfig,
  ClientMessage,
  HealthResponse,
  LinearStatus,
  Run,
  RunEvent,
  ServerMessage,
  Ticket,
  WorkerView,
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
  linearStatus: LinearStatus | null;
  health: HealthResponse | null;
  workers: WorkerView[];
  events: Record<string, RunEvent[] | undefined>;
  loadedRuns: Record<string, true | undefined>;
  busy: Record<string, true | undefined>;
  notice: string | null;
  selectedRunId: string | null;
  /** True once runs/tickets have arrived from either transport. */
  loaded: boolean;
  page: Page;
}

type Action =
  | { t: "conn"; conn: Connection }
  | {
      t: "hello";
      runs: Run[];
      tickets: Ticket[];
      config: BreviConfig;
      linearStatus: LinearStatus;
      workers: WorkerView[];
    }
  | { t: "config"; config: BreviConfig }
  | { t: "linear-status"; linearStatus: LinearStatus }
  | { t: "tickets"; tickets: Ticket[] }
  | { t: "workers"; workers: WorkerView[] }
  | { t: "run"; run: Run }
  | { t: "event"; event: RunEvent }
  | { t: "seed"; runs?: Run[]; tickets?: Ticket[]; health?: HealthResponse; workers?: WorkerView[] }
  | { t: "history"; runId: string; events: RunEvent[] }
  | { t: "busy"; key: string; on: boolean }
  | { t: "notice"; notice: string | null }
  | { t: "select"; runId: string | null }
  | { t: "page"; page: Page };

const initial: State = {
  conn: "connecting",
  runs: [],
  tickets: [],
  config: null,
  linearStatus: null,
  health: null,
  workers: [],
  events: {},
  loadedRuns: {},
  busy: {},
  notice: null,
  selectedRunId: null,
  loaded: false,
  page: "home",
};

/** Runs live at /runs/<id> so any run view can be linked to directly. */
function runIdFromPath(pathname: string): string | null {
  const match = /^\/runs\/([^/]+)\/?$/.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function pathForRun(runId: string | null): string {
  return runId ? `/runs/${encodeURIComponent(runId)}` : "/";
}

export type ConfigSection =
  | "connectors"
  | "repositories"
  | "agent"
  | "sandbox"
  | "workers"
  | "memory"
  | "orchestrator"
  | "server";

export type Page = "home" | "setup" | `config:${ConfigSection}`;

/** Non-run pages live at fixed paths; anything else is the home/run view. */
function pageFromPath(pathname: string): Page {
  if (/^\/setup\/?$/.test(pathname)) return "setup";
  const match =
    /^\/config(?:\/(connectors|repositories|agent|sandbox|workers|memory|orchestrator|server))?\/?$/.exec(
      pathname,
    );
  if (!match) return "home";
  const section = (match[1] ?? "connectors") as ConfigSection;
  return `config:${section}`;
}

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
        linearStatus: action.linearStatus,
        workers: action.workers,
        loaded: true,
      };
    case "config":
      return { ...state, config: action.config };
    case "linear-status":
      return { ...state, linearStatus: action.linearStatus };
    case "tickets":
      return { ...state, tickets: action.tickets };
    case "workers":
      return { ...state, workers: action.workers };
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
        workers: action.workers ?? state.workers,
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
    case "page":
      return state.page === action.page ? state : { ...state, page: action.page };
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
  const [state, dispatch] = useReducer(reducer, initial, (base) => ({
    ...base,
    page: pageFromPath(window.location.pathname),
    selectedRunId: runIdFromPath(window.location.pathname),
  }));
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
            dispatch({
              t: "hello",
              runs: msg.runs,
              tickets: msg.tickets,
              config: msg.config,
              linearStatus: msg.linearStatus,
              workers: msg.workers,
            });
            break;
          case "config":
            dispatch({ t: "config", config: msg.config });
            break;
          case "linear-status":
            dispatch({ t: "linear-status", linearStatus: msg.linearStatus });
            break;
          case "tickets":
            dispatch({ t: "tickets", tickets: msg.tickets });
            break;
          case "workers":
            dispatch({ t: "workers", workers: msg.workers });
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
    const [runs, tickets, health, fleet] = await Promise.all([
      api.runs().catch(() => undefined),
      api.tickets().catch(() => undefined),
      api.health().catch(() => undefined),
      api.workers().catch(() => undefined),
    ]);
    if (runs || tickets || health || fleet) {
      dispatch({ t: "seed", runs, tickets, health, workers: fleet?.workers });
    }
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
  const selectRun = useCallback(
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

  /** Select a run and record it in the URL so the view can be shared. */
  const openRun = useCallback(
    (runId: string | null) => {
      const path = pathForRun(runId);
      if (window.location.pathname !== path) window.history.pushState(null, "", path);
      dispatch({ t: "page", page: "home" });
      selectRun(runId);
    },
    [selectRun],
  );

  /** Open a Configuration section at its own URL. */
  const openConfig = useCallback(
    (section: ConfigSection = "connectors") => {
      const path = `/config/${section}`;
      if (window.location.pathname !== path) window.history.pushState(null, "", path);
      dispatch({ t: "page", page: `config:${section}` });
      selectRun(null);
    },
    [selectRun],
  );

  // A bare /config URL is valid (defaults to Connectors) but should not stay
  // in the address bar as-is: normalize it to the real section URL on load
  // without adding a history entry, so refresh reflects the actual page.
  useEffect(() => {
    if (/^\/config\/?$/.test(window.location.pathname)) {
      window.history.replaceState(null, "", "/config/connectors");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only
  }, []);

  // Deep link: a run opened by URL needs its console history like any other open.
  useEffect(() => {
    const runId = selected.current;
    if (!runId) return;
    api
      .events(runId)
      .then((events) => dispatch({ t: "history", runId, events }))
      .catch(() => dispatch({ t: "history", runId, events: [] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only
  }, []);

  // Browser back/forward moves between runs without reloading.
  useEffect(() => {
    const onPop = () => {
      dispatch({ t: "page", page: pageFromPath(window.location.pathname) });
      selectRun(runIdFromPath(window.location.pathname));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [selectRun]);

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

  const retryRun = useCallback(async (runId: string) => {
    dispatch({ t: "busy", key: runId, on: true });
    dispatch({ t: "notice", notice: null });
    try {
      dispatch({ t: "run", run: await api.retryRun(runId) });
    } catch (err) {
      dispatch({ t: "notice", notice: `Could not retry the run. ${errorText(err)}` });
    } finally {
      dispatch({ t: "busy", key: runId, on: false });
    }
  }, []);

  const followUpRun = useCallback(async (runId: string) => {
    dispatch({ t: "busy", key: runId, on: true });
    dispatch({ t: "notice", notice: null });
    try {
      dispatch({ t: "run", run: await api.followUpRun(runId) });
    } catch (err) {
      dispatch({ t: "notice", notice: `Could not start the follow-up. ${errorText(err)}` });
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

  /** Adopt the fleet returned by a worker mutation, ahead of the next socket message. */
  const applyWorkers = useCallback(
    (workers: WorkerView[]) => dispatch({ t: "workers", workers }),
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
    openConfig,
    runTicket,
    cancelRun,
    retryRun,
    followUpRun,
    dismissNotice,
    applyConfig,
    applyWorkers,
  };
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "The orchestrator did not respond.";
}
