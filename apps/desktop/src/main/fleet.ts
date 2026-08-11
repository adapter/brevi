import WebSocket from "ws";
import type { LinearStatus, Run, ServerMessage, Ticket } from "@brevi/shared";
import { restartDelay } from "./backoff.js";
import { ACTIVE_STATUSES } from "./summary.js";

export interface FleetState {
  connected: boolean;
  runs: Run[];
  tickets: Ticket[];
  linearStatus: LinearStatus | null;
}

export interface FleetMonitorOptions {
  /** http base url of the orchestrator. */
  url: string;
  onChange: (state: FleetState) => void;
  /** A run reached a terminal status while we were watching it. */
  onRunFinished: (run: Run) => void;
}

function upsert(runs: Run[], run: Run): Run[] {
  const index = runs.findIndex((r) => r.id === run.id);
  if (index === -1) return [run, ...runs];
  const next = [...runs];
  next[index] = run;
  return next;
}

function parseMessage(raw: string): ServerMessage | null {
  try {
    return JSON.parse(raw) as ServerMessage;
  } catch {
    return null;
  }
}

/**
 * Whether observing `status` right after `previous` is a completion or failure
 * worth notifying about: the run has to have actually been active last we
 * knew (an unknown `previous` means we never saw it running, so there's
 * nothing to report a transition out of).
 */
export function isFreshCompletion(
  previous: Run["status"] | undefined,
  status: Run["status"],
): boolean {
  return (
    previous !== undefined && ACTIVE_STATUSES.has(previous) && (status === "completed" || status === "failed")
  );
}

/**
 * Watches the orchestrator's /ws endpoint from the main process, so the tray
 * and notifications track runs without a dashboard window open. Mirrors
 * apps/app/src/lib/useOrchestrator.ts's connection handling, minus the REST
 * fallback (the tray only needs eventual consistency, not a poller).
 */
export class FleetMonitor {
  #options: FleetMonitorOptions;
  #ws: WebSocket | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #attempts = 0;
  #stopped = true;
  /** Last status observed per run, to detect transitions into a terminal state, live or across a reconnect. */
  #knownStatus = new Map<string, Run["status"]>();
  /** Run ids we've already fired onRunFinished for, so a reconnect can't repeat a notification. */
  #notified = new Set<string>();
  /**
   * Whether we've processed the process's first `hello` yet. That one only
   * seeds state; every `hello` after it is a reconnect snapshot that gets
   * diffed against #knownStatus to recover completions missed while the
   * socket was down.
   */
  #firstHello = true;
  #state: FleetState = { connected: false, runs: [], tickets: [], linearStatus: null };

  constructor(options: FleetMonitorOptions) {
    this.#options = options;
  }

  get state(): FleetState {
    return this.#state;
  }

  start(): void {
    this.#stopped = false;
    this.#open();
  }

  /**
   * Repoint at a different orchestrator address, reconnecting when it changed.
   * The next hello is a first hello: the runs behind the old address are not a
   * reconnect snapshot of this one, and diffing against them would replay
   * their completions as fresh notifications.
   */
  setUrl(url: string): void {
    if (this.#options.url === url) return;
    const wasRunning = !this.#stopped;
    this.stop();
    this.#options = { ...this.#options, url };
    this.#firstHello = true;
    if (wasRunning) this.start();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    const ws = this.#ws;
    this.#ws = null;
    ws?.close();
  }

  #open(): void {
    if (this.#stopped) return;
    const url = `${this.#options.url.replace(/^http/, "ws")}/ws`;
    const ws = new WebSocket(url);
    this.#ws = ws;

    ws.on("open", () => {
      this.#attempts = 0;
      this.#update({ connected: true });
    });

    ws.on("message", (data) => {
      const msg = parseMessage(data.toString());
      if (msg) this.#handle(msg);
    });

    ws.on("close", () => {
      if (this.#ws !== ws) return; // superseded by a later socket already
      this.#ws = null;
      if (this.#stopped) return;
      this.#update({ connected: false });
      this.#scheduleReconnect();
    });

    ws.on("error", () => ws.close());
  }

  #scheduleReconnect(): void {
    this.#attempts += 1;
    this.#reconnectTimer = setTimeout(() => this.#open(), restartDelay(this.#attempts));
  }

  #update(patch: Partial<FleetState>): void {
    this.#state = { ...this.#state, ...patch };
    this.#options.onChange(this.#state);
  }

  #handle(msg: ServerMessage): void {
    switch (msg.type) {
      case "hello":
        if (this.#firstHello) {
          this.#firstHello = false;
          // Seed known statuses without firing onRunFinished: a fresh launch
          // must never replay notifications for runs that finished earlier.
          // Runs that are already terminal go straight into the dedup set
          // too, since we never observed an active->terminal transition for
          // them and never want to notify for one later.
          for (const run of msg.runs) {
            this.#knownStatus.set(run.id, run.status);
            if (!ACTIVE_STATUSES.has(run.status)) this.#notified.add(run.id);
          }
        } else {
          // Reconnect snapshot: diff against what we last knew per run to
          // recover completions/failures that landed while the socket was
          // down, including runs the orchestrator force-failed on its own
          // restart before we reconnected. Runs missing from #knownStatus
          // were created and finished entirely during the disconnect: we
          // never saw them active, so there's no transition to report and
          // notifying would just be noise on a long outage.
          for (const run of msg.runs) {
            const previous = this.#knownStatus.get(run.id);
            this.#knownStatus.set(run.id, run.status);
            this.#maybeNotify(previous, run);
          }
        }
        this.#prune(msg.runs);
        this.#update({ runs: msg.runs, tickets: msg.tickets, linearStatus: msg.linearStatus });
        break;
      case "run-updated": {
        const previous = this.#knownStatus.get(msg.run.id);
        this.#knownStatus.set(msg.run.id, msg.run.status);
        this.#update({ runs: upsert(this.#state.runs, msg.run) });
        this.#maybeNotify(previous, msg.run);
        break;
      }
      case "tickets":
        this.#update({ tickets: msg.tickets });
        break;
      case "linear-status":
        this.#update({ linearStatus: msg.linearStatus });
        break;
      default:
        // run-event and config are irrelevant to the tray.
        break;
    }
  }

  /** Fires onRunFinished at most once per run id, across live updates and any number of reconnects. */
  #maybeNotify(previous: Run["status"] | undefined, run: Run): void {
    if (this.#notified.has(run.id)) return;
    if (!isFreshCompletion(previous, run.status)) return;
    this.#notified.add(run.id);
    this.#options.onRunFinished(run);
  }

  /** Keeps #knownStatus/#notified bounded to the runs the server still reports, mirroring how #state.runs is server-bounded. */
  #prune(runs: readonly Run[]): void {
    const ids = new Set(runs.map((r) => r.id));
    for (const id of this.#knownStatus.keys()) if (!ids.has(id)) this.#knownStatus.delete(id);
    for (const id of this.#notified) if (!ids.has(id)) this.#notified.delete(id);
  }
}
