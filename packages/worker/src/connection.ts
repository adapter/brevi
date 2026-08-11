import { WebSocket } from "ws";
import {
  parseHostMessage,
  WORKER_HEARTBEAT_MS,
  WORKER_PROTOCOL_VERSION,
  WORKER_WS_PATH,
  type HostMessage,
  type RegisterMessage,
  type RunLease,
  type WorkerCapabilities,
  type WorkerMessage,
} from "@brevi/shared";

/** First reconnect delay; doubles on every failed attempt up to WORKER_BACKOFF_MAX_MS. */
const WORKER_BACKOFF_INITIAL_MS = 1_000;
const WORKER_BACKOFF_MAX_MS = 30_000;
/** Outbound frames buffered while disconnected; oldest run-event frames drop first once full. */
const OUTBOUND_QUEUE_LIMIT = 10_000;

export interface WorkerConnectionOptions {
  /** The host's base url (http(s)://...); ws(s):// and WORKER_WS_PATH are derived from it. */
  hostUrl: string;
  token: string;
  workerId: string;
  name: string;
  capabilities: WorkerCapabilities;
  /** Evaluated fresh on every register and heartbeat: the leases this worker still believes it owns. */
  activeLeases: () => RunLease[];
  /**
   * Evaluated fresh on every successful registration: frames the host has not
   * acknowledged yet, requeued so a reconnect replays them. Handing a frame to
   * the socket is not delivery, and a completion lost that way would otherwise
   * strand its run forever, since the lease stays claimed and nothing resends.
   * Replays are safe to duplicate: the host drops frames for a lease it has
   * already settled, and acks a lease it no longer knows about.
   */
  unacknowledged?: () => WorkerMessage[];
}

export interface WorkerConnection {
  send(message: WorkerMessage): void;
  onHostMessage(handler: (message: HostMessage) => void): void;
  /** Outbound frames not yet handed to the socket; shutdown polls this instead of closing blind. */
  pendingCount(): number;
  /** Waits (polling) up to timeoutMs for the outbound queue to fully drain, e.g. across a reconnect; resolves false if the deadline passes first instead of throwing, so a caller can log and proceed rather than hang. */
  drain(timeoutMs: number): Promise<boolean>;
  close(): void;
}

/** `http(s)://host[:port]` -> `ws(s)://host[:port]/ws/worker`. */
function toWsUrl(hostUrl: string): string {
  const url = new URL(WORKER_WS_PATH, hostUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/** Up to 30% extra on top of the base delay, so a fleet reconnecting together doesn't hammer the host in lockstep. */
function withJitter(baseMs: number): number {
  return baseMs + Math.random() * baseMs * 0.3;
}

/**
 * The outbound half of the worker <-> host protocol. Workers only ever dial
 * out (never listen), so this is the worker's one network connector: it
 * opens the socket at WORKER_WS_PATH, registers, and reconnects with
 * exponential backoff (jittered, capped at 30s) whenever the socket drops,
 * resetting the delay once a reconnect actually registers again. Every
 * inbound frame is validated with parseHostMessage before it reaches the
 * handler, so a malformed or unrecognized frame is silently ignored rather
 * than crashing the daemon.
 *
 * Messages sent while disconnected (or before the host has confirmed
 * `registered`) are queued in order and flushed on the next successful
 * registration; this is what lets a reconnect resume in-flight run
 * reporting instead of losing whatever happened during the drop. The queue
 * is bounded: once full, the oldest `run-event` frame is dropped first
 * (cheapest to lose; a status/patch/complete frame still gets through), and
 * that is noted on the console once, not on every drop.
 */
export function connectToHost(options: WorkerConnectionOptions): WorkerConnection {
  const { hostUrl, token, workerId, name, capabilities, activeLeases, unacknowledged } = options;
  const wsUrl = toWsUrl(hostUrl);

  let socket: WebSocket | undefined;
  let closed = false;
  let registered = false;
  let backoffMs = WORKER_BACKOFF_INITIAL_MS;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  // Each flips back once the corresponding condition resolves, so the next
  // occurrence logs again instead of staying silent forever.
  let loggedDisconnect = false;
  let loggedDrop = false;
  let loggedUnregistered = false;
  // Tracks whether the socket currently in flight ever actually opened, so a
  // close can tell "opened but the host never registered it" (a bad token, a
  // protocol mismatch that didn't get a `rejected` frame, a host that's
  // listening but isn't actually brevi) apart from a plain connection
  // failure (unreachable host, refused port), which gets no special log.
  let opened = false;
  let handler: (message: HostMessage) => void = () => {};

  const queue: WorkerMessage[] = [];

  const enqueue = (message: WorkerMessage): void => {
    if (queue.length >= OUTBOUND_QUEUE_LIMIT) {
      const dropIndex = queue.findIndex((m) => m.type === "run-event");
      if (dropIndex >= 0) queue.splice(dropIndex, 1);
      else queue.shift();
      if (!loggedDrop) {
        loggedDrop = true;
        console.error("[brevi] worker outbound queue is full; dropping messages until the connection recovers");
      }
    }
    queue.push(message);
  };

  const flush = (): void => {
    if (!registered || !socket || socket.readyState !== WebSocket.OPEN) return;
    while (queue.length > 0) {
      const message = queue.shift();
      if (message) socket.send(JSON.stringify(message));
    }
  };

  const send = (message: WorkerMessage): void => {
    enqueue(message);
    flush();
  };

  const stopHeartbeat = (): void => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  };

  const startHeartbeat = (): void => {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      send({ type: "heartbeat", ts: new Date().toISOString(), leaseIds: activeLeases().map((lease) => lease.id) });
    }, WORKER_HEARTBEAT_MS);
    heartbeatTimer.unref?.();
  };

  const scheduleReconnect = (): void => {
    if (closed || reconnectTimer) return;
    const delayMs = withJitter(backoffMs);
    backoffMs = Math.min(backoffMs * 2, WORKER_BACKOFF_MAX_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delayMs);
    reconnectTimer.unref?.();
  };

  const connect = (): void => {
    if (closed) return;
    const ws = new WebSocket(wsUrl);
    socket = ws;
    opened = false;

    ws.on("open", () => {
      opened = true;
      const register: RegisterMessage = {
        type: "register",
        protocolVersion: WORKER_PROTOCOL_VERSION,
        workerId,
        name,
        token,
        capabilities,
        activeLeases: activeLeases(),
      };
      ws.send(JSON.stringify(register));
    });

    ws.on("message", (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        return; // not JSON; ignore rather than crash the socket on it
      }
      const message = parseHostMessage(parsed);
      if (!message) return;

      if (message.type === "registered") {
        registered = true;
        loggedDisconnect = false;
        loggedDrop = false;
        loggedUnregistered = false;
        backoffMs = WORKER_BACKOFF_INITIAL_MS;
        console.log(`[brevi] registered with ${hostUrl} as worker "${name}" (host ${message.hostVersion})`);
        startHeartbeat();
        // Requeued behind anything already waiting, so a replayed completion
        // still trails the frames that were reported before it. A frame still
        // sitting in the queue was never handed to a socket and needs no
        // replay: enqueueing it again would flush both copies before either
        // could be acknowledged, and the host would complete the lease twice.
        for (const message of unacknowledged?.() ?? []) {
          if (!queue.includes(message)) enqueue(message);
        }
        flush();
        return;
      }
      if (message.type === "rejected") {
        // A bad pairing token (or a protocol mismatch) will not fix itself
        // by retrying: fail loudly and let the process manager (or the
        // operator) decide what to do, rather than backing off forever.
        console.error(`[brevi] the host rejected this worker: ${message.reason}`);
        closed = true;
        stopHeartbeat();
        if (reconnectTimer) clearTimeout(reconnectTimer);
        ws.close();
        process.exit(1);
      }
      handler(message);
    });

    ws.on("close", () => {
      const wasRegistered = registered;
      const wasOpened = opened;
      registered = false;
      stopHeartbeat();
      if (!closed) {
        if (wasRegistered) {
          if (!loggedDisconnect) {
            loggedDisconnect = true;
            console.error(`[brevi] lost the connection to ${hostUrl}; reconnecting...`);
          }
        } else if (wasOpened && !loggedUnregistered) {
          // The socket opened (so the host is reachable and speaking
          // WebSocket) but closed before ever sending `registered`, and it
          // wasn't a `rejected` either (that path exits the process outright
          // above): a bad option or a host that isn't actually brevi looks
          // different from a plain transient drop, so this gets its own line
          // instead of silently retrying forever with no explanation.
          loggedUnregistered = true;
          console.error(`[brevi] connected to ${hostUrl} but registration was not accepted; retrying...`);
        }
        scheduleReconnect();
      }
    });

    // "close" always follows "error" for a ws client socket; nothing extra
    // to do here beyond not letting the default 'error' behavior crash the
    // process on an unhandled event.
    ws.on("error", () => {});
  };

  connect();

  return {
    send,
    onHostMessage(next: (message: HostMessage) => void): void {
      handler = next;
    },
    pendingCount(): number {
      return queue.length;
    },
    async drain(timeoutMs: number): Promise<boolean> {
      // Polls rather than hooking into flush(): a drain only ever happens
      // once, during shutdown, so the simplicity of polling outweighs the
      // cost of an interval tick. The queue can still be non-empty at the
      // deadline if the socket is disconnected and reconnecting (flush()
      // only sends once registered); the caller decides what to do with a
      // `false` return rather than this waiting forever.
      const deadline = Date.now() + Math.max(0, timeoutMs);
      while (queue.length > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return queue.length === 0;
    },
    close(): void {
      closed = true;
      stopHeartbeat();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    },
  };
}
