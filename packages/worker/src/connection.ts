import { WebSocket } from "ws";
import {
  parseHostMessage,
  WORKER_HEARTBEAT_MS,
  WORKER_PROTOCOL_VERSION,
  WORKER_WS_PATH,
  type HostMessage,
  type RegisteredMessage,
  type RegisterMessage,
  type RunLease,
  type WorkerAuth,
  type WorkerCapabilities,
  type WorkerDenyReason,
  type WorkerMessage,
  type WorkerState,
} from "@brevi/shared";
import { clearEnrollment, type WorkerEnrollment } from "./identity.js";

/** First reconnect delay; doubles on every failed attempt up to WORKER_BACKOFF_MAX_MS. */
const WORKER_BACKOFF_INITIAL_MS = 1_000;
const WORKER_BACKOFF_MAX_MS = 30_000;
/** Outbound frames buffered while disconnected; oldest run-event frames drop first once full. */
const OUTBOUND_QUEUE_LIMIT = 10_000;

export interface WorkerConnectionOptions {
  /** The host's base url (http(s)://...); ws(s):// and WORKER_WS_PATH are derived from it. */
  hostUrl: string;
  /**
   * A single-use pairing token (`brevi worker --token`), minted on the host's
   * Workers page. Only needed to enroll: for the first connection from this
   * machine, or to re-enroll one whose credential the host no longer honours.
   */
  token?: string;
  /** What an earlier enrollment on this host left behind; absent until this machine has redeemed a pairing token. */
  enrollment?: WorkerEnrollment;
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
  /**
   * A durable credential just arrived, meaning enrollment succeeded: persist
   * it. Awaited before this connection does anything else with the frame that
   * carried it, because it is the only copy that will ever exist (the host
   * keeps a hash) and the pairing token that bought it is already spent.
   */
  onEnrolled?: (record: WorkerEnrollment) => void | Promise<void>;
  /** The operator's state for this worker: from `registered`, from every heartbeat-ack, and pushed the moment a drain or an enable happens. */
  onState?: (state: WorkerState) => void;
  /** This enrollment was killed on the host. The credential is dead, so there is nothing to reconnect with and the daemon stops for good. */
  onRevoked?: (reason: string) => void;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
 *
 * Every connection also carries an auth envelope, and this is where a
 * machine's enrollment happens: a supplied pairing token is redeemed once for
 * a durable credential (delivered on the `registered` frame that answers it),
 * and every connection after that presents the credential instead. Which of
 * the two is used is decided per attempt, so a token the host refuses can
 * fall back to a stored credential on the next one.
 */
export function connectToHost(options: WorkerConnectionOptions): WorkerConnection {
  const { hostUrl, name, capabilities, activeLeases, unacknowledged } = options;
  const wsUrl = toWsUrl(hostUrl);

  // A supplied token wins over a stored credential on the first attempt, even
  // when both exist: an operator who pastes a freshly minted --token is doing
  // so because they believe the stored one no longer works, and that is how a
  // machine whose enrollment was revoked re-enrolls in a single command. It is
  // dropped once it has been redeemed (or refused), so a reconnect never
  // replays a token that is by then spent.
  let pairingToken = options.token;
  let enrollment = options.enrollment;
  if (!pairingToken && !enrollment) {
    // Nothing to authenticate with at all: retrying forever would only produce
    // rejections, so this is fatal before a socket is ever opened.
    throw new Error(
      `This machine is not enrolled with ${hostUrl} and no --token was given. Mint a pairing token on that host (Configuration > Workers, "Add a worker") and pass it with --token.`,
    );
  }
  // The id the host assigned this worker, adopted from `registered`; a worker
  // never picks its own (see identity.ts).
  let workerId = enrollment?.workerId;

  let socket: WebSocket | undefined;
  let closed = false;
  let revoked = false;
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

  /** What this attempt presents itself with; undefined only if both the token and the credential are gone, which connectToHost's guard above rules out. */
  const authFor = (): WorkerAuth | undefined => {
    if (pairingToken) return { kind: "pairing", token: pairingToken };
    if (enrollment) return { kind: "credential", workerId: enrollment.workerId, secret: enrollment.credential };
    return undefined;
  };

  /** Refuses to retry: a rejection of this kind cannot fix itself, so the process manager (or the operator) decides what happens next rather than a backoff loop hiding it. */
  const fatal = (reason: string): never => {
    console.error(`[brevi] ${reason}`);
    closed = true;
    stopHeartbeat();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close();
    return process.exit(1);
  };

  /**
   * A successful registration, and the one place enrollment can complete: a
   * `credential` on this frame means the pairing token was just redeemed for
   * it, and this is the only copy of it that will ever exist (the host keeps
   * a hash). Storing it therefore happens before anything else this frame
   * triggers, which is what the async body is for: the token is spent either
   * way, so a crash in between would cost the operator a new one.
   */
  const onRegistered = async (message: RegisteredMessage): Promise<void> => {
    if (message.credential) {
      const record: WorkerEnrollment = { workerId: message.workerId, credential: message.credential, host: hostUrl };
      enrollment = record;
      try {
        await options.onEnrolled?.(record);
        console.log(`[brevi] enrolled with ${hostUrl} as worker "${message.name}" (${message.workerId})`);
      } catch (error) {
        // Not fatal: this connection is authenticated and can execute runs
        // fine. Only the next start is affected, so it is worth saying now
        // rather than discovering it at the next boot.
        console.error(
          `[brevi] could not store this worker's credential: ${errorMessage(error)}. This session keeps working, but the next start will need a fresh pairing token.`,
        );
      }
    }
    // The id is the host's to assign, always: whatever it enrolled this
    // worker under is what this connection is, not what the worker guessed.
    workerId = message.workerId;
    // Redeemed, so a reconnect must not replay it; a token is single-use and
    // presenting a spent one would be refused.
    pairingToken = undefined;
    registered = true;
    loggedDisconnect = false;
    loggedDrop = false;
    loggedUnregistered = false;
    backoffMs = WORKER_BACKOFF_INITIAL_MS;
    console.log(
      `[brevi] registered with ${hostUrl} as worker "${message.name}" (${workerId}, host ${message.hostVersion})`,
    );
    startHeartbeat();
    // Requeued behind anything already waiting, so a replayed completion
    // still trails the frames that were reported before it. A frame still
    // sitting in the queue was never handed to a socket and needs no
    // replay: enqueueing it again would flush both copies before either
    // could be acknowledged, and the host would complete the lease twice.
    for (const pending of unacknowledged?.() ?? []) {
      if (!queue.includes(pending)) enqueue(pending);
    }
    flush();
    options.onState?.(message.state);
  };

  /**
   * The host refused this registration. What happens next is decided by
   * `code`, never by the prose in `reason`: a pairing token worth falling
   * back from is a different situation from an enrollment that is gone.
   */
  const onRejected = (code: WorkerDenyReason, reason: string): void => {
    stopHeartbeat();
    if (code === "invalid-token" || code === "expired-token") {
      if (enrollment) {
        // The token is stale, mistyped, or already redeemed, but this machine
        // still holds a credential from an earlier enrollment here. Drop the
        // token and let the reconnect that this rejection's close schedules
        // present the credential instead of quitting with a dead token.
        console.error(
          `[brevi] the host did not accept the pairing token (${reason}); reconnecting with this machine's stored credential instead`,
        );
        pairingToken = undefined;
        return;
      }
      fatal(
        `the host did not accept the pairing token: ${reason}. Mint a fresh one on the host (Configuration > Workers) and pass it with --token.`,
      );
      return;
    }
    if (code === "unauthorized") {
      // The credential this machine holds is dead: every later start would
      // fail in exactly this way, so forget it rather than keep a rejection
      // loop alive, and say what actually fixes it.
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      void clearEnrollment()
        .catch((error: unknown) => console.error(`[brevi] could not remove the stored credential: ${errorMessage(error)}`))
        .finally(() =>
          fatal(
            `this worker's enrollment is no longer valid: ${reason}. Enroll this machine again with a fresh pairing token (Configuration > Workers on the host).`,
          ),
        );
      return;
    }
    // "protocol" and "malformed": a version or a frame the host will not
    // accept from this build, which retrying cannot change.
    fatal(`the host rejected this worker: ${reason}`);
  };

  const connect = (): void => {
    if (closed) return;
    const ws = new WebSocket(wsUrl);
    socket = ws;
    opened = false;

    ws.on("open", () => {
      opened = true;
      // Decided per attempt, not once: the enrollment state can have changed
      // since the last one (a token redeemed into a credential, a token the
      // host refused while a usable credential is still on disk).
      const auth = authFor();
      if (!auth) {
        // Unreachable by construction (connectToHost throws when it starts
        // with neither, and a token is only dropped when a credential can take
        // over), but reconnecting forever with nothing to present would be
        // pure noise if it ever happened.
        fatal(`nothing left to authenticate with against ${hostUrl}; enroll again with a fresh pairing token`);
        return;
      }
      const register: RegisterMessage = {
        type: "register",
        protocolVersion: WORKER_PROTOCOL_VERSION,
        auth,
        name,
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
        void onRegistered(message);
        return;
      }
      if (message.type === "rejected") {
        onRejected(message.code, message.reason);
        return;
      }
      if (message.type === "revoked") {
        // The credential behind this connection is gone on the host, so
        // reconnecting with it would only be refused: stop for good, and let
        // the daemon shut down whatever it is still running.
        console.error(`[brevi] the host revoked this worker's enrollment: ${message.reason}`);
        revoked = true;
        closed = true;
        stopHeartbeat();
        if (reconnectTimer) clearTimeout(reconnectTimer);
        options.onRevoked?.(message.reason);
        return;
      }
      // Both carry the operator's state for this worker: the ack so a drain
      // still reaches a worker that missed the push, the push so it takes
      // effect at once rather than at the next heartbeat.
      if (message.type === "heartbeat-ack" || message.type === "worker-state") options.onState?.(message.state);
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
      // A revoked worker has nothing left to flush to: the host closed the
      // socket and would refuse anything this worker still sends, so waiting
      // the deadline out would only delay the shutdown by the full timeout.
      while (queue.length > 0 && !revoked && Date.now() < deadline) {
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
