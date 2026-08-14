import { WebSocket } from "ws";
import {
  parseHostMessage,
  WORKER_HEARTBEAT_MS,
  WORKER_PROTOCOL_VERSION,
  WORKER_REPLAY_BUFFER_LIMIT,
  WORKER_WS_PATH,
  type HostMessage,
  type RegisteredMessage,
  type RegisterMessage,
  type RunArtifactMessage,
  type RunCompleteMessage,
  type RunEventMessage,
  type RunLease,
  type RunMemoriesMessage,
  type RunPatchMessage,
  type WorkerAuth,
  type WorkerCapabilities,
  type WorkerDenyReason,
  type WorkerMessage,
  type WorkerState,
} from "@brevi/shared";
import type { WorkerEnrollment } from "./identity.js";

/** First reconnect delay; doubles on every failed attempt up to WORKER_BACKOFF_MAX_MS. */
const WORKER_BACKOFF_INITIAL_MS = 1_000;
const WORKER_BACKOFF_MAX_MS = 30_000;
/** Outbound frames buffered while disconnected; oldest run-event frames drop first once full. */
const OUTBOUND_QUEUE_LIMIT = 10_000;
/**
 * How long a lease may sit `awaitingAck` after `registered` before this gives
 * up waiting for the host's `lease-ack`/`run-complete-ack` and resends
 * everything the buffer holds anyway. An older host that predates lease-acks,
 * or a single lost frame on a host that does send them, must degrade to
 * "resend everything" rather than to a lease that never reports again.
 */
const REPLAY_UNBLOCK_MS = 10_000;

/** How often this worker checks whether a lease it holds has passed its deadline; see the fencing note on `onLeaseLost`. */
const LEASE_DEADLINE_SWEEP_MS = 5_000;

/** The five lease-scoped reporting frame types; every other WorkerMessage travels through the generic queue instead. */
type ReportingMessage = RunPatchMessage | RunEventMessage | RunArtifactMessage | RunMemoriesMessage | RunCompleteMessage;

function isReportingMessage(message: WorkerMessage): message is ReportingMessage {
  return (
    message.type === "run-patch" ||
    message.type === "run-event" ||
    message.type === "run-artifact" ||
    message.type === "run-memories" ||
    message.type === "run-complete"
  );
}

/** Frame types the buffer cap may drop, tried in this order: run-event first (cheapest to lose, same policy as the generic queue), then run-artifact. A run-patch, run-memories, or run-complete is never dropped: any of those missing would leave the host's own copy of the run wrong, not just its console short a line. */
const DROPPABLE_TYPES: ReadonlyArray<ReportingMessage["type"]> = ["run-event", "run-artifact"];

/**
 * Per-lease replay state: every lease-scoped reporting frame lives here from
 * the moment it's sent until the host acknowledges it, so a dead socket never
 * loses one, only delays it.
 */
interface LeaseBuffer {
  /** Last sequence number assigned for this lease; frames are numbered from 1. */
  seq: number;
  /** Frames the host has not acknowledged yet, oldest first. */
  frames: ReportingMessage[];
  /** True while this lease is waiting to be told where the host got to, so nothing new is sent past a gap. */
  awaitingAck: boolean;
  /**
   * The watermark the host reported on its previous `lease-ack` for this
   * lease, so a second one carrying the same number is recognisable as a
   * whole heartbeat interval of no progress. -1 until the first ack arrives,
   * which is therefore never mistaken for a repeat.
   */
  lastAckedSeq: number;
  /**
   * Highest sequence number this buffer has already told the host it no
   * longer holds anything at or below (see `lease-gap`). 0 when nothing has
   * been given up on, which is the normal case.
   */
  gapThrough: number;
  /** Frames dropped by the cap since the last `lease-gap` went out, for that frame's count. */
  droppedSinceGap: number;
  /** The lease's deadline as the host last stated it, epoch ms; 0 until a dispatch or a lease-ack says. */
  expiresAt: number;
}

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
  /**
   * The presented credential was rejected outright ("unauthorized"): forget
   * whatever local state backs it, or every later start repeats the
   * rejection. The caller supplies it because only the caller knows whether
   * disk state applies: a stored enrollment clears ~/.brevi/worker.json, a
   * supervisor-injected one has nothing on disk to forget.
   */
  forgetCredential?: () => void | Promise<void>;
  /**
   * A lease this worker holds is no longer this worker's: abort whatever is
   * running for it and report nothing, because the host has already given the
   * run to somebody else.
   *
   * This is the fence around a re-dispatched run, and it fires for both ways
   * a lease can be lost. The host says so explicitly when a worker reconnects
   * still claiming a lease it no longer holds; and a worker that never
   * reconnects reaches the lease's own `expiresAt` and stops itself, which is
   * the half no frame from the host could ever cover. Two workers pushing the
   * same deterministic branch is exactly what this prevents.
   */
  onLeaseLost?: (leaseId: string, runId: string, reason: string) => void;
}

export interface WorkerConnection {
  send(message: WorkerMessage): void;
  onHostMessage(handler: (message: HostMessage) => void): void;
  /** Outbound frames not yet acknowledged: the generic queue plus every lease's buffered reporting frames. */
  pendingCount(): number;
  /** Waits (polling) up to timeoutMs for both the generic queue and every lease's replay buffer to fully drain, e.g. across a reconnect and its replay; resolves false if the deadline passes first instead of throwing, so a caller can log and proceed rather than hang. */
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
 * Every connection also carries an auth envelope, and this is where a
 * machine's enrollment happens: a supplied pairing token is redeemed once for
 * a durable credential (delivered on the `registered` frame that answers it),
 * and every connection after that presents the credential instead. Which of
 * the two is used is decided per attempt, so a token the host refuses can
 * fall back to a stored credential on the next one.
 *
 * The outbound path is split in two, because the two halves need different
 * survival guarantees:
 *
 * - A generic queue carries everything that is not lease-scoped reporting
 *   (register, heartbeat, worker-log, dispatch-accepted, dispatch-rejected,
 *   attach-*). It only ever holds frames not yet handed to a socket, is
 *   bounded (oldest run-event drops first once full, though none of this
 *   queue's frame types are actually run-events in practice), and flushes
 *   in order on the next successful registration.
 * - A per-lease replay buffer carries the five lease-scoped reporting frames
 *   (run-patch, run-event, run-artifact, run-memories, run-complete). A
 *   reporting frame is never put in the generic queue: `send` stamps it with
 *   a per-lease, strictly increasing `seq` and routes it straight into its
 *   lease's buffer, where it stays until the host's `lease-ack` or
 *   `run-complete-ack` says otherwise. Handing a frame to the socket is not
 *   delivery, and losing one that way would otherwise put a permanent hole in
 *   the host's console for that run (or, for run-complete, strand the lease
 *   forever, since claimedLeases in daemon.ts only releases it on ack). A
 *   lease whose buffer is `awaitingAck` (set on every socket close, cleared
 *   by the matching `lease-ack`, or by the REPLAY_UNBLOCK_MS backstop) holds
 *   everything new instead of sending past the gap the host hasn't
 *   reconciled yet; see the module's `send` and `flushLease`.
 *
 * Because reporting frames never reach the generic queue, that queue can
 * never itself contain one to drop on close; nothing here needs to filter it
 * for that case; the invariant is enforced structurally by `send` routing
 * reporting frames only into `sendReporting`.
 */
export function connectToHost(options: WorkerConnectionOptions): WorkerConnection {
  const { hostUrl, name, capabilities, activeLeases } = options;
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
  let replayBackstopTimer: NodeJS.Timeout | undefined;
  // Each flips back once the corresponding condition resolves, so the next
  // occurrence logs again instead of staying silent forever.
  let loggedDisconnect = false;
  let loggedDrop = false;
  let loggedUnregistered = false;
  let loggedBufferFull = false;
  // Tracks whether the socket currently in flight ever actually opened, so a
  // close can tell "opened but the host never registered it" (a bad token, a
  // protocol mismatch that didn't get a `rejected` frame, a host that's
  // listening but isn't actually brevi) apart from a plain connection
  // failure (unreachable host, refused port), which gets no special log.
  let opened = false;
  let handler: (message: HostMessage) => void = () => {};
  /** Run id per lease, so an expiring lease can name the run it fences. */
  const leaseRuns = new Map<string, string>();

  const queue: WorkerMessage[] = [];
  const leaseBuffers = new Map<string, LeaseBuffer>();
  // Frames already handed to the current socket, so a steady-state lease-ack
  // (or an already-unblocked buffer) doesn't resend what's already in
  // flight. Scoped to the current socket: rebuilt fresh on every connect(),
  // since a frame handed to a socket that's since died was never actually
  // delivered and must be eligible for the next session's replay.
  let delivered = new WeakSet<ReportingMessage>();

  const getOrCreateLeaseBuffer = (leaseId: string): LeaseBuffer => {
    let buffer = leaseBuffers.get(leaseId);
    if (!buffer) {
      buffer = { seq: 0, frames: [], awaitingAck: false, lastAckedSeq: -1, gapThrough: 0, droppedSinceGap: 0, expiresAt: 0 };
      leaseBuffers.set(leaseId, buffer);
    }
    return buffer;
  };

  /**
   * Tell the host about everything this lease has given up on, so its
   * watermark can step over the hole. Sent through the generic queue rather
   * than the lease's own buffer: the buffer is exactly what is stuck behind
   * the hole, so a frame announcing it cannot live there. Re-sent on every
   * registration, since a host that restarted before its debounced watermark
   * write landed would otherwise wait for frames nobody has.
   */
  const reportLeaseGap = (leaseId: string, runId: string, buffer: LeaseBuffer): void => {
    if (buffer.gapThrough <= 0) return;
    send({ type: "lease-gap", leaseId, runId, throughSeq: buffer.gapThrough, dropped: buffer.droppedSinceGap });
  };

  /**
   * Hold a lease's buffer to WORKER_REPLAY_BUFFER_LIMIT, dropping the
   * cheapest frames first. Dropping punches a hole in the lease's sequence
   * numbers, and the host's watermark will not cross one on its own, so every
   * drop is accounted for: `gapThrough` moves up to just below the oldest
   * frame still held, which is by definition the point below which everything
   * has been either acknowledged or dropped, and the host is told (see
   * reportLeaseGap). Without that the buffer would grow forever behind a
   * watermark that could never advance.
   */
  const capLeaseBuffer = (leaseId: string, runId: string, buffer: LeaseBuffer): void => {
    let dropped = 0;
    while (buffer.frames.length > WORKER_REPLAY_BUFFER_LIMIT) {
      let index = -1;
      for (const type of DROPPABLE_TYPES) {
        index = buffer.frames.findIndex((frame) => frame.type === type);
        if (index >= 0) break;
      }
      // Nothing left that's safe to drop (only run-patch/run-memories/
      // run-complete remain): let the buffer exceed the cap rather than
      // corrupt the host's eventual copy of the run.
      if (index < 0) break;
      const [gone] = buffer.frames.splice(index, 1);
      if (gone) delivered.delete(gone);
      dropped += 1;
      if (!loggedBufferFull) {
        loggedBufferFull = true;
        console.error(`[brevi] worker replay buffer for lease ${leaseId} is full; dropping frames until the host catches up`);
      }
    }
    if (dropped === 0) return;
    buffer.droppedSinceGap += dropped;
    // Everything below the oldest frame still held is gone for good: either
    // the host acknowledged it, or this cap dropped it.
    const oldest = buffer.frames[0]?.seq ?? buffer.seq + 1;
    buffer.gapThrough = Math.max(buffer.gapThrough, oldest - 1);
    reportLeaseGap(leaseId, runId, buffer);
  };

  const flushLease = (buffer: LeaseBuffer): void => {
    if (!registered || !socket || socket.readyState !== WebSocket.OPEN || buffer.awaitingAck) return;
    for (const frame of buffer.frames) {
      if (delivered.has(frame)) continue;
      delivered.add(frame);
      socket.send(JSON.stringify(frame));
    }
  };

  const sendReporting = (message: ReportingMessage): void => {
    const buffer = getOrCreateLeaseBuffer(message.leaseId);
    // Every reporting frame names its run, which is what a lease-gap needs to
    // be addressed to; a lease this connection never saw dispatched (it
    // reconnected mid-run) learns its run id here.
    leaseRuns.set(message.leaseId, message.runId);
    const stamped = { ...message, seq: ++buffer.seq } as ReportingMessage;
    buffer.frames.push(stamped);
    capLeaseBuffer(message.leaseId, message.runId, buffer);
    flushLease(buffer);
  };

  const enqueue = (message: WorkerMessage): void => {
    if (queue.length >= OUTBOUND_QUEUE_LIMIT) {
      // Cheapest first, and never a `lease-gap`: that frame is what unsticks
      // the host's watermark, so dropping it would strand every lease behind
      // the hole it was announcing.
      const dropIndex = queue.findIndex((m) => m.type === "run-event" || m.type === "worker-log");
      if (dropIndex >= 0) queue.splice(dropIndex, 1);
      else {
        const keepIndex = queue.findIndex((m) => m.type !== "lease-gap");
        if (keepIndex >= 0) queue.splice(keepIndex, 1);
      }
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
    if (isReportingMessage(message)) {
      sendReporting(message);
      return;
    }
    enqueue(message);
    flush();
  };

  /** Forget a lease entirely: no buffer, no deadline, nothing left to replay or renew. */
  const forgetLease = (leaseId: string): void => {
    leaseBuffers.delete(leaseId);
    leaseRuns.delete(leaseId);
  };

  /**
   * The worker half of the fence. A lease carries a deadline the host renews
   * on every heartbeat, so passing it means this worker has been out of touch
   * for longer than the host was ever going to wait: the host has written the
   * lease off and may already have given the run to another worker. Stopping
   * here is what keeps two workers off the same branch, and it is the only
   * thing that can, since a worker in this state is by definition not
   * receiving anything the host sends.
   */
  const sweepLeaseDeadlines = (): void => {
    const now = Date.now();
    for (const [leaseId, buffer] of Array.from(leaseBuffers)) {
      if (buffer.expiresAt === 0 || buffer.expiresAt > now) continue;
      const runId = leaseRuns.get(leaseId) ?? "";
      console.error(`[brevi] lease ${leaseId} for run ${runId} passed its deadline with no word from the host; abandoning the run`);
      forgetLease(leaseId);
      options.onLeaseLost?.(leaseId, runId, "the lease expired while this worker could not reach the host");
    }
  };
  const leaseSweepTimer = setInterval(sweepLeaseDeadlines, LEASE_DEADLINE_SWEEP_MS);
  leaseSweepTimer.unref?.();

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
    // Deliberately not unref'd, unlike the heartbeat timer: between a drop and
    // the next attempt this is the only handle left, since the socket is gone
    // and signal listeners don't hold the loop open. An unref'd one lets the
    // process exit during the backoff, so `brevi worker` would die of the host
    // restarting rather than reconnect through it. Every path that stops the
    // worker for good (close, a fatal rejection, a revoke) clears this timer,
    // so keeping it referenced cannot delay a shutdown either.
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delayMs);
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
    loggedBufferFull = false;
    backoffMs = WORKER_BACKOFF_INITIAL_MS;
    console.log(
      `[brevi] registered with ${hostUrl} as worker "${message.name}" (${workerId}, host ${message.hostVersion})`,
    );
    startHeartbeat();
    // Restate every hole this worker has given up on before anything else
    // goes out. A host that restarted before its debounced watermark write
    // landed is back to waiting for frames nobody has any more, and only this
    // frame can tell it to stop; re-sending one it already applied is a
    // no-op.
    for (const [leaseId, buffer] of leaseBuffers) {
      const runId = leaseRuns.get(leaseId);
      if (runId) reportLeaseGap(leaseId, runId, buffer);
    }
    flush();
    // Backstop against a host that never answers with a lease-ack or
    // run-complete-ack for a lease this worker re-claimed: an older host
    // (predates the lease-ack frame) or a single lost ack must not leave
    // that lease's buffer stuck awaiting one forever. Rescheduled on
    // every registration, so a lease-ack that arrives first (the normal
    // path) always wins and this simply never fires for it.
    stopReplayBackstop();
    replayBackstopTimer = setTimeout(() => {
      for (const buffer of leaseBuffers.values()) {
        if (!buffer.awaitingAck) continue;
        buffer.awaitingAck = false;
        flushLease(buffer);
      }
    }, REPLAY_UNBLOCK_MS);
    replayBackstopTimer.unref?.();
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
      void Promise.resolve(options.forgetCredential?.())
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

  const stopReplayBackstop = (): void => {
    if (replayBackstopTimer) clearTimeout(replayBackstopTimer);
    replayBackstopTimer = undefined;
  };

  const connect = (): void => {
    if (closed) return;
    const ws = new WebSocket(wsUrl);
    socket = ws;
    opened = false;
    delivered = new WeakSet<ReportingMessage>();

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
        stopReplayBackstop();
        if (reconnectTimer) clearTimeout(reconnectTimer);
        options.onRevoked?.(message.reason);
        return;
      }
      // Both carry the operator's state for this worker: the ack so a drain
      // still reaches a worker that missed the push, the push so it takes
      // effect at once rather than at the next heartbeat.
      if (message.type === "heartbeat-ack" || message.type === "worker-state") options.onState?.(message.state);
      if (message.type === "dispatch") {
        // Note the lease's deadline before the daemon starts executing: it is
        // what this worker fences itself with if the host goes silent.
        const buffer = getOrCreateLeaseBuffer(message.lease.id);
        leaseRuns.set(message.lease.id, message.lease.runId);
        if (message.lease.expiresAt) buffer.expiresAt = Date.parse(message.lease.expiresAt);
        handler(message);
        return;
      }
      if (message.type === "lease-lost") {
        // The host has moved on: whatever is running for this lease has to
        // stop, and nothing about it is worth sending any more.
        console.error(`[brevi] the host took back lease ${message.leaseId} for run ${message.runId}: ${message.reason}`);
        forgetLease(message.leaseId);
        options.onLeaseLost?.(message.leaseId, message.runId, message.reason);
        return;
      }
      if (message.type === "lease-ack") {
        // Handled entirely here, like registered/rejected: it's connection
        // bookkeeping, not something daemon.ts's dispatch/cancel/discard
        // handler needs to see.
        const buffer = leaseBuffers.get(message.leaseId);
        if (buffer) {
          // Every ack is also a renewal: the host restates the deadline it
          // is holding, and this worker stops the run itself if it lapses.
          buffer.expiresAt = Date.parse(message.expiresAt);
          leaseRuns.set(message.leaseId, message.runId);
          buffer.frames = buffer.frames.filter((frame) => (frame.seq ?? 0) > message.seq);
          // The host has reported the same watermark twice while frames it
          // has still not acknowledged are outstanding. On a live connection
          // that means a whole heartbeat interval passed with no progress, so
          // whatever went out past that point did not land (a write that
          // failed host-side), and it will never be resent on its own:
          // `delivered` remembers handing it to this socket, and only a
          // disconnect clears that. Making those frames eligible again is
          // what retries them, and it is the only thing that recovers a
          // run-complete whose write failed while the socket stayed healthy.
          // Duplicates cost nothing: the host drops a frame it has already
          // applied by seq.
          if (message.seq === buffer.lastAckedSeq) {
            for (const frame of buffer.frames) delivered.delete(frame);
          }
          buffer.lastAckedSeq = message.seq;
          buffer.awaitingAck = false;
          flushLease(buffer); // the replay: whatever the host hasn't applied yet, in order
        }
        return;
      }
      if (message.type === "run-complete-ack") {
        // The host is done with this lease: nothing left to replay for it,
        // and nothing left to fence. Still forwarded below so daemon.ts can
        // release its own claim.
        forgetLease(message.leaseId);
      }
      handler(message);
    });

    ws.on("close", () => {
      const wasRegistered = registered;
      const wasOpened = opened;
      registered = false;
      stopHeartbeat();
      stopReplayBackstop();
      // Every lease still holding unacknowledged frames now has to wait for
      // the reconnect to tell it where the host got to, so nothing sends
      // past the gap this drop just created.
      for (const buffer of leaseBuffers.values()) buffer.awaitingAck = true;
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

  const pendingCount = (): number => {
    let count = queue.length;
    for (const buffer of leaseBuffers.values()) count += buffer.frames.length;
    return count;
  };

  connect();

  return {
    send,
    onHostMessage(next: (message: HostMessage) => void): void {
      handler = next;
    },
    pendingCount,
    async drain(timeoutMs: number): Promise<boolean> {
      // Polls rather than hooking into flush()/flushLease(): a drain only
      // ever happens once, during shutdown, so the simplicity of polling
      // outweighs the cost of an interval tick. pendingCount() can still be
      // non-zero at the deadline if the socket is disconnected and
      // reconnecting, or a lease is still awaitingAck its lease-ack; the
      // caller decides what to do with a `false` return rather than this
      // waiting forever.
      const deadline = Date.now() + Math.max(0, timeoutMs);
      // A revoked worker has nothing left to flush to: the host closed the
      // socket and would refuse anything this worker still sends, so waiting
      // the deadline out would only delay the shutdown by the full timeout.
      while (pendingCount() > 0 && !revoked && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return pendingCount() === 0;
    },
    close(): void {
      closed = true;
      stopHeartbeat();
      stopReplayBackstop();
      clearInterval(leaseSweepTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    },
  };
}
