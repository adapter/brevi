import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import {
  parseWorkerMessage,
  registerMessageSchema,
  WORKER_HEARTBEAT_MS,
  WORKER_MAX_ARTIFACT_BYTES,
  WORKER_PROTOCOL_VERSION,
  type ArtifactRef,
  type AttachDataMessage,
  type AttachErrorMessage,
  type AttachExitMessage,
  type BreviConfig,
  type DispatchPrompts,
  type HostMessage,
  type RegisterMessage,
  type RepoConfig,
  type Run,
  type RunArtifactMessage,
  type RunCompleteMessage,
  type RunMemoriesMessage,
  type RunPatch,
  type SandboxProviderName,
  type WorkerDenyReason,
  type WorkerMessage,
  type WorkerState,
  type WorkerView,
} from "@brevi/shared";
import type { FleetStore, WorkerRecord } from "./fleet.js";
import { MemoryStore } from "./memory.js";
import { isSafePathSegment, resolveWithin } from "./safepath.js";
import { isTerminal, RunStore } from "./state.js";

/**
 * A worker daemon willing to execute runs. The host is a pure scheduler: it
 * never boots a sandbox itself, it dials nothing out, and every fact about a
 * run's execution (its log lines, its cost entries, its PR, its final
 * status) arrives here over the socket the worker opened. This module is the
 * host's half of that relationship: who's connected, who owns which run
 * right now, and how a dropped connection is given a chance to come back
 * before its runs are given up on.
 *
 * It is also the enrollment gate. Whether a connecting machine is allowed
 * here at all is decided by the FleetStore in fleet.ts, which this registry
 * consults on every register frame: a worker either redeems a single-use
 * pairing token (enrolling, and receiving a durable credential in the
 * answer) or authenticates with the credential a previous enrollment bought
 * it. A worker record can exist with no live connection (enrolled but
 * offline); a live connection always corresponds to exactly one record,
 * because nothing installs one without a successful redeem or authenticate.
 */

const require = createRequire(import.meta.url);

const HOST_VERSION = ((): string => {
  try {
    return (require("../package.json") as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/** A worker's first frame must be a valid `register` within this long, or the socket is dropped. */
const REGISTRATION_TIMEOUT_MS = 10_000;

/**
 * A heartbeat that changes nothing (the worker still claims exactly the
 * leases it claimed last time) still refreshes lastSeenAt in the store, but
 * that alone isn't worth waking every dashboard client every
 * WORKER_HEARTBEAT_MS. Instead the age shown for an idle worker is allowed to
 * lag reality by up to this much before the next heartbeat emits anyway, so
 * it never grows unbounded on a screen someone left open.
 */
const HEARTBEAT_BROADCAST_MS = 30_000;

/** One connected worker's socket and what it told us about itself. */
interface ConnectedWorker {
  id: string;
  name: string;
  socket: WebSocket;
  capabilities: RegisterMessage["capabilities"];
  /** Remote address of the socket, for the Workers page; undefined when the transport didn't report one. */
  address?: string;
  connectedAt: string;
  lastSeenAt: string;
  /**
   * The lease ids this worker claimed on its last heartbeat, sorted and
   * joined. Compared against the next heartbeat's to tell an idle keep-alive
   * apart from one that reports work finishing (see #handleHeartbeat).
   */
  claimedLeases: string;
}

/** One outstanding dispatch, tracked host-side. Mirrors RunLease minus the fields the wire form needs but bookkeeping doesn't. */
interface Lease {
  id: string;
  runId: string;
  workerId: string;
  /**
   * What this dispatch asked the worker to do. Carried so a rejection can tell
   * the scheduler which kind of work to rebuild when it requeues the run: a
   * follow-up that came back rejected must not be retried as a fresh
   * implementation against a PR that already exists.
   */
  kind: DispatchRequest["kind"];
}

/** A worker's leases while its socket is down but its reconnect window hasn't expired yet. */
interface GraceEntry {
  leaseIds: Set<string>;
  timer: NodeJS.Timeout;
}

interface AttachSessionEntry {
  workerId: string;
  /** The run this session is attached to, so hasAttachSession can answer without a second index. */
  runId: string;
  onData(data: string): void;
  onExit(code: number): void;
  onError(message: string): void;
}

export interface AttachSessionOptions {
  cols: number;
  rows: number;
  onData(data: string): void;
  onExit(code: number): void;
  onError(message: string): void;
}

export interface AttachSession {
  input(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

/** What the scheduler hands the registry to dispatch one run; the registry fills in the lease. */
export interface DispatchRequest {
  kind: "implementation" | "follow-up";
  run: Run;
  repoKey: string;
  repo: RepoConfig;
  /** The full live config: per-run credentials travel with the dispatch, not just what the run needs. */
  config: BreviConfig;
  prompts: DispatchPrompts;
}

export interface WorkerRegistryOptions {
  config: BreviConfig;
  store: RunStore;
  memories: MemoryStore;
  /** Who is enrolled, and the credentials that prove it; see fleet.ts. */
  fleet: FleetStore;
  /** A run reached a terminal or waiting state; the caller re-arms whatever follow-on timer that implies and tries to dispatch more of the queue. */
  onRunSettled(runId: string): void;
  /** A worker rejected (or lost) a dispatch before doing any work; the caller requeues the run. */
  onRunRejected(runId: string, reason: string, kind: DispatchRequest["kind"]): void;
}

interface WorkerRegistryEvents {
  workers: [WorkerView[]];
}

/** What cancel() managed to do: "unknown" when the run has no active lease at all. */
export type CancelOutcome = "sent" | "pending" | "unknown";

/** Parse one text frame as JSON, or undefined when it isn't well-formed JSON. */
function safeJsonParse(raw: unknown): unknown {
  try {
    return JSON.parse(String(raw));
  } catch {
    return undefined;
  }
}

/** True for a parsed frame that at least claims to be a `register` message, before it's run through the schema. */
function looksLikeRegister(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "register";
}

/**
 * Translate a wire RunPatch back into a RunStore patch: the protocol uses
 * `null` for "clear this field" because JSON drops `undefined` keys outright
 * (see worker.ts), so every present key is unwrapped one level. `id` and
 * `ticket` can never appear here; the schema doesn't have fields for them, so
 * a worker has no way to write over either. `sandbox` is excluded: it's a
 * merge patch of its own (see mergeSandbox), not a flat field.
 */
function patchFromWire(patch: RunPatch): Partial<Omit<Run, "id" | "sandbox">> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === "sandbox") continue;
    out[key] = value === null ? undefined : value;
  }
  return out as Partial<Omit<Run, "id" | "sandbox">>;
}

/**
 * The sandbox fields a run-patch or run-complete frame can report. A
 * run-complete's copy is a straight snapshot and never carries a `null`; a
 * run-patch's may, for any field, since that is how it retracts one.
 */
type SandboxWirePatch = {
  provider?: SandboxProviderName | null;
  id?: string | null;
  retainedUntil?: string | null;
};

/**
 * Merge a worker-reported sandbox patch onto the sandbox already stored for
 * the run, rather than replacing it: a frame that only reports `id` must not
 * blow away a `retainedUntil` an earlier frame set. `workerId` is always
 * forced to the reporting lease's worker instead of anything the patch says
 * (there is no such field on the wire anymore): the host derives ownership
 * from the lease, never from a worker's say-so, so a worker can't drop or
 * reassign it by omission or otherwise. A `null` clears the field it names
 * (`retainedUntil: null` ends retention, `id: null` retracts a destroyed
 * sandbox); an absent key leaves whatever is already stored alone.
 */
function mergeSandbox(current: Run["sandbox"], patch: SandboxWirePatch | null | undefined, workerId: string): Run["sandbox"] {
  const next: Run["sandbox"] = { ...current, workerId };
  if (!patch) return next;
  if (patch.provider !== undefined) next.provider = patch.provider ?? undefined;
  if (patch.id !== undefined) next.id = patch.id ?? undefined;
  if (patch.retainedUntil !== undefined) next.retainedUntil = patch.retainedUntil ?? undefined;
  return next;
}

export class WorkerRegistry extends EventEmitter<WorkerRegistryEvents> {
  readonly #config: BreviConfig;
  readonly #store: RunStore;
  readonly #memories: MemoryStore;
  readonly #fleet: FleetStore;
  readonly #onRunSettled: (runId: string) => void;
  readonly #onRunRejected: (runId: string, reason: string, kind: DispatchRequest["kind"]) => void;

  #workers = new Map<string, ConnectedWorker>();
  #leases = new Map<string, Lease>();
  #leaseByRun = new Map<string, string>();
  #grace = new Map<string, GraceEntry>();
  #heartbeatTimers = new Map<string, NodeJS.Timeout>();
  #attachSessions = new Map<string, AttachSessionEntry>();
  /** Leases with a cancel requested against them, so a disconnected worker's owning lease is re-cancelled the moment it reconnects. */
  #cancelIntents = new Set<string>();
  /** Artifact names actually saved to disk per lease, so run-complete's manifest check has something to compare against. */
  #savedArtifacts = new Map<string, Set<string>>();
  /**
   * Tail of each lease's write chain. Frames arrive in order on one socket but
   * their handlers are async, so a run-artifact still writing bytes when the
   * run-complete behind it lands would be reconciled as "never reached the
   * host" and then recorded after the lease's bookkeeping was already torn
   * down. Appending here keeps a lease's writes in the order they were sent,
   * and lets run-complete wait for the ones ahead of it.
   */
  #leaseWrites = new Map<string, Promise<void>>();
  /**
   * Leases whose completion is being applied. Settling is async, so two
   * run-complete frames for one lease can both pass the lease lookup before
   * either settles, and a duplicate is expected by design: a worker replays a
   * completion it holds no acknowledgement for, which is exactly what happens
   * when the ack itself is lost. Completing twice would double the terminal
   * events, the artifact reconciliation and the scheduler's settled callback.
   */
  #completing = new Set<string>();
  /** Chain that registration and revoke() serialize on; see #serialize. */
  #gate: Promise<void> = Promise.resolve();
  /** Set by stop(); a close event arriving after shutdown has nothing left to clean up. */
  #stopped = false;
  /** Epoch ms of the last `workers` emit; drives the heartbeat throttle (see #handleHeartbeat). */
  #lastEmitAt = 0;

  constructor(options: WorkerRegistryOptions) {
    super();
    this.#config = options.config;
    this.#store = options.store;
    this.#memories = options.memories;
    this.#fleet = options.fleet;
    this.#onRunSettled = options.onRunSettled;
    this.#onRunRejected = options.onRunRejected;
  }

  /**
   * Handle one freshly-upgraded `WORKER_WS_PATH` socket. Nothing is trusted
   * before a valid `register` frame arrives: no other message type is acted
   * on, and a socket that never sends one is dropped once the registration
   * timeout passes.
   */
  accept(socket: WebSocket, address?: string): void {
    let entry: ConnectedWorker | undefined;
    /** Set between the register frame arriving and the host answering it; see below. */
    let registering = false;
    let closed = false;
    const pendingTimer = setTimeout(() => {
      const reason = `no register frame within ${REGISTRATION_TIMEOUT_MS / 1000}s`;
      console.warn(`[brevi] rejected a worker connection: ${reason}`);
      this.#reject(socket, "malformed", reason);
      socket.terminate();
    }, REGISTRATION_TIMEOUT_MS);
    pendingTimer.unref();

    socket.on("message", (raw) => {
      const parsed = safeJsonParse(raw);
      if (!entry) {
        // Registration is asynchronous now (it awaits fleet-state writes), so
        // a frame arriving in that window is neither pre-register traffic to
        // wait on nor post-register traffic to act on: the connection has no
        // identity to attribute it to yet, so it is dropped.
        if (registering) return;
        if (!looksLikeRegister(parsed)) return; // not a register frame (or not even JSON); the registration timer is the real deadline
        clearTimeout(pendingTimer);
        const result = registerMessageSchema.safeParse(parsed);
        if (!result.success) {
          const issue = result.error.issues[0];
          const reason = issue ? (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message) : "malformed register frame";
          console.warn(`[brevi] rejected a worker registration: ${reason}`);
          this.#reject(socket, "malformed", reason);
          socket.close();
          return;
        }
        registering = true;
        // #handleRegister awaits fleet-state writes that can reject (full
        // disk, bad permissions). Left unhandled that becomes an unhandled
        // rejection and can take the host process down over one worker's
        // registration, so it is caught here and the socket refused instead.
        void this.#handleRegister(socket, result.data, address).then(
          (registered) => {
            registering = false;
            if (!registered) {
              socket.close(); // #handleRegister already sent `rejected`
              return;
            }
            entry = registered;
            // The socket went away while its registration was still in
            // flight, so its "close" had nothing to clean up at the time;
            // run that path now against the connection just installed.
            if (closed) this.#handleDisconnect(registered);
          },
          (error: unknown) => {
            registering = false;
            console.error(`[brevi] worker registration failed: ${error instanceof Error ? error.message : String(error)}`);
            this.#reject(socket, "malformed", "registration could not be completed");
            socket.close();
          },
        );
        return;
      }
      const message = parseWorkerMessage(parsed);
      if (!message) return; // malformed frame; ignored rather than fatal, this connection is already registered
      this.#handleMessage(entry.id, message);
    });

    socket.on("close", () => {
      closed = true;
      clearTimeout(pendingTimer);
      if (entry) this.#handleDisconnect(entry);
    });
    // "error" is always followed by "close" on a ws socket; let that path do the cleanup.
    socket.on("error", () => socket.terminate());
  }

  /**
   * Every enrolled worker, connected or not: the Workers page shows a machine
   * that is merely offline as a member of the fleet, not as a gap. The
   * enrollment record is the source of truth for identity and state, and
   * whatever live connection exists is merged onto it.
   */
  list(): WorkerView[] {
    return this.#fleet.list().map((record) => {
      const live = this.#workers.get(record.id);
      const view: WorkerView = {
        id: record.id,
        name: record.name,
        state: record.state,
        connection: live ? "online" : "offline",
        activeRuns: this.#leasesForWorker(record.id).length,
        enrolledAt: record.enrolledAt,
      };
      // What the worker reported on this connection beats what it reported on
      // its last one: a worker that gained /dev/kvm, or was restarted with a
      // different concurrency, says so at register time.
      const capabilities = live?.capabilities ?? record.capabilities;
      if (capabilities) view.capabilities = capabilities;
      if (live) view.connectedAt = live.connectedAt;
      // Prefer the live connection's own lastSeenAt over the store's: the
      // store's copy only advances when a heartbeat's write lands, so between
      // that write starting and finishing the connection's in-memory value is
      // the more current one.
      const lastSeenAt = live?.lastSeenAt ?? record.lastSeenAt;
      if (lastSeenAt) view.lastSeenAt = lastSeenAt;
      if (live?.address) view.address = live.address;
      return view;
    });
  }

  /**
   * Sum of every connected worker's maxConcurrency, draining workers
   * excluded: a drained machine finishes what it holds but is no longer part
   * of the capacity the scheduler is allowed to plan against.
   */
  capacity(): number {
    let total = 0;
    for (const worker of this.#workers.values()) {
      if (this.#isDraining(worker.id)) continue;
      total += worker.capabilities.maxConcurrency;
    }
    return total;
  }

  /** Runs with an active lease right now, across every worker. */
  inFlight(): number {
    return this.#leases.size;
  }

  /** Mint a single-use pairing token; redeeming it is what enrolls a machine. */
  mintPairingToken(): { token: string; expiresAt: string } {
    return this.#fleet.mintPairingToken();
  }

  /** Rename an enrolled worker. `name` is trusted to already be sanitized and non-empty. */
  async rename(id: string, name: string): Promise<boolean> {
    if (!(await this.#fleet.rename(id, name))) return false;
    this.#emitWorkers();
    return true;
  }

  /**
   * Set the operator-controlled state. A connected worker is told
   * immediately rather than at its next heartbeat, so a drain stops it
   * taking on local work as soon as the operator asked for it; the host's own
   * dispatching stops the moment the record is written, either way.
   */
  async setState(id: string, state: WorkerState): Promise<boolean> {
    if (!(await this.#fleet.setState(id, state))) return false;
    const live = this.#workers.get(id);
    if (live) this.#send(live.socket, { type: "worker-state", state });
    this.#emitWorkers();
    return true;
  }

  /**
   * Revoke an enrollment: drop the record and, only once that write is
   * durable, disconnect the live connection. Persisting first is what makes
   * a successful return mean both things happened; closing the socket first
   * and then failing to persist would report an error to the operator after
   * the worker had already been told it was revoked, which is backwards.
   * Serialized against registration on the same #gate: see #serialize for
   * the race that closes.
   */
  async revoke(id: string): Promise<boolean> {
    return this.#serialize(async () => {
      if (!(await this.#fleet.revoke(id))) return false;
      const live = this.#workers.get(id);
      if (live) {
        this.#send(live.socket, { type: "revoked", reason: "This worker's enrollment was revoked." });
        this.#workers.delete(id);
        const timer = this.#heartbeatTimers.get(id);
        if (timer) clearTimeout(timer);
        this.#heartbeatTimers.delete(id);
        // The socket's own "close" still runs #handleDisconnect, which is
        // what strands whatever leases this worker was holding: a revoked
        // worker's in-flight runs are given up on exactly like a worker that
        // walked away.
        live.socket.close();
        // close() is graceful and can hang forever against a dead peer or a
        // wedged proxy; a successful revoke has to guarantee disconnection,
        // not just ask for it, so force it if the handshake doesn't finish.
        setTimeout(() => live.socket.terminate(), 1000).unref();
      }
      this.#emitWorkers();
      return true;
    });
  }

  /**
   * Dispatch one run to whichever connected worker has the most free
   * capacity (maxConcurrency minus its current lease count). Returns false
   * with nothing sent when no worker has room; the run simply stays queued.
   */
  dispatch(payload: DispatchRequest): boolean {
    const target = this.#pickWorker();
    if (!target) return false;

    const issuedAt = new Date().toISOString();
    const leaseId = randomUUID();
    this.#leases.set(leaseId, { id: leaseId, runId: payload.run.id, workerId: target.id, kind: payload.kind });
    this.#leaseByRun.set(payload.run.id, leaseId);

    const run: Run = { ...payload.run, sandbox: { ...payload.run.sandbox, workerId: target.id } };
    void this.#store.update(payload.run.id, { sandbox: run.sandbox });

    this.#send(target.socket, {
      type: "dispatch",
      lease: { id: leaseId, runId: payload.run.id, issuedAt },
      kind: payload.kind,
      run,
      repoKey: payload.repoKey,
      repo: payload.repo,
      config: payload.config,
      prompts: payload.prompts,
    });
    return true;
  }

  /**
   * Ask the run's owning worker to cancel it. "unknown" when no lease is
   * active for the run (already finished, or never dispatched); otherwise the
   * cancellation intent is recorded against the lease so a worker that's
   * currently disconnected still gets cancelled the moment it reconnects (see
   * the replay in #handleRegister).
   */
  cancel(runId: string): CancelOutcome {
    const leaseId = this.#leaseByRun.get(runId);
    const lease = leaseId ? this.#leases.get(leaseId) : undefined;
    if (!lease) return "unknown";
    this.#cancelIntents.add(lease.id);
    const worker = this.#workers.get(lease.workerId);
    if (!worker) return "pending"; // disconnected, within its reconnect grace window
    this.#send(worker.socket, { type: "cancel", leaseId: lease.id, runId });
    return "sent";
  }

  /** Ask the worker holding a retained sandbox to drop it. False when that worker isn't connected right now. */
  discard(runId: string): boolean {
    const worker = this.#workerForRun(runId);
    if (!worker) return false;
    this.#send(worker.socket, { type: "discard", runId });
    return true;
  }

  /** The worker that executed (or is executing) a run, resolved from `run.sandbox.workerId`. */
  workerFor(runId: string): { id: string; name: string } | undefined {
    const worker = this.#workerForRun(runId);
    return worker ? { id: worker.id, name: worker.name } : undefined;
  }

  /** Whether any interactive attach session is currently open for a run. */
  hasAttachSession(runId: string): boolean {
    for (const session of this.#attachSessions.values()) {
      if (session.runId === runId) return true;
    }
    return false;
  }

  /**
   * Open an interactive attach session against a run's owning worker: mints
   * an attachId, sends `attach-open`, and routes that worker's `attach-data`
   * / `attach-exit` / `attach-error` frames back to the given callbacks.
   * Returns undefined when the owning worker isn't connected right now (a
   * retained sandbox on a disconnected worker can't be reached).
   */
  openAttach(runId: string, options: AttachSessionOptions): AttachSession | undefined {
    const worker = this.#workerForRun(runId);
    if (!worker) return undefined;
    const workerId = worker.id;
    const attachId = randomUUID();
    this.#attachSessions.set(attachId, {
      workerId,
      runId,
      onData: options.onData,
      onExit: options.onExit,
      onError: options.onError,
    });
    this.#send(worker.socket, {
      type: "attach-open",
      attachId,
      runId,
      // The live config, not a snapshot: a credential rotated after the
      // sandbox was retained still has to reach it on this attach.
      config: this.#config,
      cols: options.cols,
      rows: options.rows,
    });

    return {
      input: (data) => {
        const live = this.#workers.get(workerId);
        if (live) this.#send(live.socket, { type: "attach-input", attachId, data });
      },
      resize: (cols, rows) => {
        const live = this.#workers.get(workerId);
        if (live) this.#send(live.socket, { type: "attach-resize", attachId, cols, rows });
      },
      close: () => {
        const live = this.#workers.get(workerId);
        if (live) this.#send(live.socket, { type: "attach-close", attachId });
        this.#attachSessions.delete(attachId);
      },
    };
  }

  /** Cancel every outstanding lease and close every socket; called on orchestrator shutdown. */
  stop(): void {
    this.#stopped = true;
    // Every socket below is about to be terminated regardless, so whether
    // each cancel() came back "sent" or "pending" makes no difference here.
    for (const runId of this.#leaseByRun.keys()) this.cancel(runId);
    for (const worker of this.#workers.values()) worker.socket.terminate();
    this.#workers.clear();
    for (const grace of this.#grace.values()) clearTimeout(grace.timer);
    this.#grace.clear();
    for (const timer of this.#heartbeatTimers.values()) clearTimeout(timer);
    this.#heartbeatTimers.clear();
    this.#cancelIntents.clear();
    this.#savedArtifacts.clear();
  }

  // --- internals -----------------------------------------------------------

  #workerForRun(runId: string): ConnectedWorker | undefined {
    const workerId = this.#store.get(runId)?.sandbox.workerId;
    return workerId ? this.#workers.get(workerId) : undefined;
  }

  #leasesForWorker(workerId: string): Lease[] {
    return [...this.#leases.values()].filter((lease) => lease.workerId === workerId);
  }

  /** Whether the store has this worker parked out of rotation. */
  #isDraining(workerId: string): boolean {
    return this.#fleet.get(workerId)?.state === "draining";
  }

  /**
   * The connected worker with the most free capacity, or undefined when none
   * has room. Draining workers are skipped outright: they keep the leases
   * they already hold and report them normally, they are simply never handed
   * anything new.
   */
  #pickWorker(): ConnectedWorker | undefined {
    let best: ConnectedWorker | undefined;
    let bestFree = 0;
    for (const worker of this.#workers.values()) {
      if (this.#isDraining(worker.id)) continue;
      const free = worker.capabilities.maxConcurrency - this.#leasesForWorker(worker.id).length;
      if (free > bestFree) {
        best = worker;
        bestFree = free;
      }
    }
    return best;
  }

  #send(socket: WebSocket, message: HostMessage): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  }

  #reject(socket: WebSocket, code: WorkerDenyReason, reason: string): void {
    this.#send(socket, { type: "rejected", code, reason });
  }

  #emitWorkers(): void {
    this.#lastEmitAt = Date.now();
    this.emit("workers", this.list());
  }

  /**
   * Chains `task` onto one promise so a registration and a revoke never run
   * concurrently. Without this, a revoke landing while a registration is
   * mid-await (between checking a credential and installing the live
   * connection) sees no connection to kill, deletes the record, and reports
   * success; the registration then resumes and installs a socket for a
   * worker that no longer exists. rename/setState don't touch live
   * connections in a way that races revoke, so they don't go through this.
   *
   * A rejected task still lets the chain move on (the same recovery
   * FleetStore#enqueue uses): only the caller of that particular task sees
   * the rejection.
   */
  #serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#gate.then(task, task);
    this.#gate = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Answer one register frame: authenticate it against the enrolled fleet,
   * then install the live connection. Both halves run inside #serialize, so
   * a revoke cannot land between them.
   */
  async #handleRegister(socket: WebSocket, message: RegisterMessage, address?: string): Promise<ConnectedWorker | undefined> {
    if (message.protocolVersion !== WORKER_PROTOCOL_VERSION) {
      const reason = `unsupported protocol version ${message.protocolVersion}; the host runs ${WORKER_PROTOCOL_VERSION}`;
      console.warn(`[brevi] rejected a worker registration: ${reason}`);
      this.#reject(socket, "protocol", reason);
      return undefined;
    }

    return this.#serialize(async () => {
      const auth = message.auth;
      let record: WorkerRecord;
      let credential: string | undefined;
      if (auth.kind === "pairing") {
        const result = await this.#fleet.redeemPairing(auth.token, {
          name: message.name,
          capabilities: message.capabilities,
        });
        // The denial deliberately says no more than its code already does:
        // telling "wrong token" apart from "right token, expired" is the most
        // a guesser gets, and there is no reason to spell it out twice.
        if ("error" in result) {
          console.warn(`[brevi] rejected a worker enrollment: ${result.error}`);
          this.#reject(socket, result.error, "the pairing token was not accepted");
          return undefined;
        }
        record = result.worker;
        credential = result.credential;
      } else {
        const found = this.#fleet.authenticate(auth.workerId, auth.secret);
        if (!found) {
          console.warn(`[brevi] rejected worker ${auth.workerId}: unknown or revoked credential`);
          this.#reject(socket, "unauthorized", "registration was not accepted");
          return undefined;
        }
        record =
          (await this.#fleet.touch(found.id, {
            lastSeenAt: new Date().toISOString(),
            capabilities: message.capabilities,
          })) ?? found;
      }

      // Belt and braces immediately before installing the connection: confirm
      // the worker is still enrolled. Serializing against revoke already rules
      // out the race this guards, but re-checking here is cheap and means the
      // invariant doesn't quietly depend on #serialize alone.
      if (!this.#fleet.get(record.id)) {
        this.#reject(socket, "unauthorized", "registration was not accepted");
        return undefined;
      }

      // The id is the store record's, never anything the worker chose: a
      // worker's identity comes from its enrollment, and the register frame
      // has no field to assert one with.
      const workerId = record.id;
      const previous = this.#workers.get(workerId);
      const now = new Date().toISOString();
      const entry: ConnectedWorker = {
        id: workerId,
        name: record.name,
        socket,
        capabilities: message.capabilities,
        address,
        connectedAt: now,
        lastSeenAt: now,
        claimedLeases: message.activeLeases
          .map((lease) => lease.id)
          .sort()
          .join(","),
      };
      this.#workers.set(workerId, entry);
      if (previous) {
        // Not a drop: the worker itself opened a fresh connection (a restart,
        // usually) while the host still thought the old one was live. Closing
        // it here, after the map already points at the new entry, makes its
        // own "close" handler a no-op (see #handleDisconnect's identity
        // check), so this never races the grace path below.
        console.log(`[brevi] worker ${entry.name} (${entry.id}) reconnected on a new socket; closing the previous one`);
        previous.socket.terminate();
      }

      const grace = this.#grace.get(workerId);
      if (grace) {
        clearTimeout(grace.timer);
        this.#grace.delete(workerId);
      }
      // Reconcile against what the worker says it still owns: anything this
      // host still has an active lease for, under this worker id, that the
      // worker no longer lists in activeLeases was lost on its side (finished
      // without reporting, or the process restarted mid-run) and is stranded
      // right away rather than waiting out a grace window reconnection already
      // answered. Leases it does still claim are left exactly as they were;
      // its buffered reporting resumes on this connection.
      const claimed = new Set(message.activeLeases.map((lease) => lease.id));
      for (const lease of this.#leasesForWorker(workerId)) {
        if (!claimed.has(lease.id)) void this.#strandLease(lease.id);
      }

      this.#send(socket, {
        type: "registered",
        protocolVersion: WORKER_PROTOCOL_VERSION,
        heartbeatIntervalMs: WORKER_HEARTBEAT_MS,
        hostVersion: HOST_VERSION,
        workerId,
        name: record.name,
        state: record.state,
        // Only the connection that redeemed a pairing token gets one; every
        // later registration already arrived holding it.
        ...(credential ? { credential } : {}),
      });

      // The other direction: a lease the worker still claims that this host has
      // no record of (already settled, or stranded while it was disconnected)
      // can never be accepted. Ack it right away so the worker stops holding it
      // open waiting for a reply that will never come.
      for (const claimedLease of message.activeLeases) {
        if (!this.#leases.has(claimedLease.id)) {
          this.#send(socket, { type: "run-complete-ack", leaseId: claimedLease.id, runId: claimedLease.runId });
        }
      }
      // A cancel requested while this worker was disconnected never reached it;
      // replay it now so a reconnecting worker is aborted before it resumes
      // normal run-patch / run-complete reporting.
      for (const lease of this.#leasesForWorker(workerId)) {
        if (this.#cancelIntents.has(lease.id)) {
          this.#send(socket, { type: "cancel", leaseId: lease.id, runId: lease.runId });
        }
      }

      this.#armHeartbeatWatchdog(entry);
      this.#emitWorkers();
      return entry;
    });
  }

  /** (Re)arm the timer that drops a worker for going quiet; called on register and on every heartbeat. */
  #armHeartbeatWatchdog(entry: ConnectedWorker): void {
    const existing = this.#heartbeatTimers.get(entry.id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      console.warn(`[brevi] worker ${entry.name} (${entry.id}) missed its heartbeat; dropping the connection`);
      entry.socket.terminate();
    }, this.#config.fleet.heartbeatTimeoutSeconds * 1000);
    timer.unref();
    this.#heartbeatTimers.set(entry.id, timer);
  }

  /**
   * One heartbeat: refresh the enrollment record's liveness, ack with the
   * worker's current state (which is how a drain reaches a worker that missed
   * the push), and decide whether the fleet is worth re-emitting.
   *
   * The emit does double duty, and that is the tradeoff here. Dashboards want
   * it rarely (an idle worker's lastSeenAt ticking over is not news), but the
   * scheduler listens to the same event to re-drive a queue stuck behind
   * capacity it cannot see finishing: a dispatch the worker rejected as full,
   * or runs it came back from a host restart still executing. So a heartbeat
   * that reports a change in what the worker claims always emits, and an
   * otherwise idle one emits at most every HEARTBEAT_BROADCAST_MS. The cost
   * is that a queue in that invisible-capacity state can wait up to that long
   * to be retried instead of one heartbeat interval, which is a far better
   * trade than waking every open dashboard for every worker every 15s.
   */
  async #handleHeartbeat(worker: ConnectedWorker, leaseIds: string[]): Promise<void> {
    const claimed = [...leaseIds].sort().join(",");
    const changed = claimed !== worker.claimedLeases;
    worker.claimedLeases = claimed;
    const record = await this.#fleet.touch(worker.id, { lastSeenAt: worker.lastSeenAt });
    // Re-check rather than trust the entry captured before the await: a
    // register could have installed a fresh connection for this worker while
    // the write was in flight, and acting now would speak for that newer,
    // unrelated socket.
    if (this.#workers.get(worker.id) !== worker) return;
    if (!record) {
      // touch found nothing to update, which only happens once the record is
      // gone: this worker was revoked while its socket stayed open (the
      // revoke and this heartbeat's write happened to interleave). Tell it
      // the same way a live revoke would, rather than acking as though
      // nothing had happened and leaving an orphaned connection nobody knows
      // to clean up.
      this.#send(worker.socket, { type: "revoked", reason: "This worker's enrollment was revoked." });
      this.#workers.delete(worker.id);
      worker.socket.close();
      this.#emitWorkers();
      return;
    }
    this.#send(worker.socket, { type: "heartbeat-ack", ts: new Date().toISOString(), state: record.state });
    if (changed || Date.now() - this.#lastEmitAt >= HEARTBEAT_BROADCAST_MS) this.#emitWorkers();
  }

  #handleDisconnect(entry: ConnectedWorker): void {
    // Shutdown already cancelled every lease and cleared every timer; a close
    // arriving after that must not arm a fresh grace window for a host that
    // is on its way out.
    if (this.#stopped) return;
    const current = this.#workers.get(entry.id);
    // A register on a new socket for this worker id already replaced this
    // entry (see #handleRegister); this close event is the old socket
    // catching up and must not strand leases the new connection already owns.
    // No entry at all is a different case, not a replacement: revoke() drops
    // the map entry before closing the socket, and those leases do still have
    // to be given up on, so that path falls through.
    if (current && current !== entry) return;
    this.#workers.delete(entry.id);
    const timer = this.#heartbeatTimers.get(entry.id);
    if (timer) clearTimeout(timer);
    this.#heartbeatTimers.delete(entry.id);
    this.#emitWorkers();

    const leaseIds = this.#leasesForWorker(entry.id).map((lease) => lease.id);
    if (leaseIds.length === 0) return;
    const graceSeconds = this.#config.fleet.reconnectGraceSeconds;
    console.warn(
      `[brevi] worker ${entry.name} (${entry.id}) disconnected with ${leaseIds.length} run(s) in flight; ` +
        `giving it ${graceSeconds}s to reconnect before failing them`,
    );
    const timer2 = setTimeout(() => {
      this.#grace.delete(entry.id);
      for (const leaseId of leaseIds) void this.#strandLease(leaseId);
    }, graceSeconds * 1000);
    timer2.unref();
    this.#grace.set(entry.id, { leaseIds: new Set(leaseIds), timer: timer2 });
  }

  /**
   * A lease's worker is gone for good (grace window expired with no
   * reconnect, or the reconnect itself no longer claims it): settle the
   * lease and fail the run, unless it already reached a terminal state on
   * its own (a run-complete that raced the disconnect). Simple on purpose;
   * real recovery (resuming the run on another worker) is Fleet 3.
   */
  async #strandLease(leaseId: string): Promise<void> {
    const lease = this.#leases.get(leaseId);
    if (!lease) return;
    this.#settleLease(leaseId);
    const run = this.#store.get(lease.runId);
    if (!run || isTerminal(run.status)) return;
    const text = "the worker executing this run disconnected";
    this.#store.appendEvent({ runId: lease.runId, ts: new Date().toISOString(), type: "log", stream: "system", text });
    await this.#store
      .setStatus(lease.runId, "failed", { error: text, finishedAt: new Date().toISOString() })
      .catch(() => undefined);
    this.#onRunSettled(lease.runId);
  }

  #settleLease(leaseId: string): void {
    const lease = this.#leases.get(leaseId);
    if (!lease) return;
    this.#leases.delete(leaseId);
    if (this.#leaseByRun.get(lease.runId) === leaseId) this.#leaseByRun.delete(lease.runId);
    this.#cancelIntents.delete(leaseId);
    this.#savedArtifacts.delete(leaseId);
    this.#leaseWrites.delete(leaseId);
    this.#completing.delete(leaseId);
  }

  /** A lease active for exactly this worker, or undefined; a stale or foreign leaseId must never let a message through. */
  #activeLease(workerId: string, leaseId: string): Lease | undefined {
    const lease = this.#leases.get(leaseId);
    return lease && lease.workerId === workerId ? lease : undefined;
  }

  /**
   * Resolve a lease-scoped frame's lease and guard its claimed runId against
   * the lease's actual one. Every lease-scoped frame type (dispatch-rejected,
   * run-patch, run-event, run-artifact, run-memories, run-complete) carries
   * both a leaseId and a runId, but only the lease is trustworthy: the runId
   * is dropped, with a warning, the moment it disagrees, and lease.runId is
   * what every store mutation and scheduler callback must use from here on.
   */
  #leaseFor(workerId: string, leaseId: string, runId: string, frameType: string): Lease | undefined {
    const lease = this.#activeLease(workerId, leaseId);
    if (!lease) return undefined;
    if (lease.runId !== runId) {
      console.warn(
        `[brevi] worker ${workerId} sent a ${frameType} frame for lease ${leaseId} claiming run ${runId}, ` +
          `but that lease belongs to run ${lease.runId}; dropped`,
      );
      return undefined;
    }
    return lease;
  }

  #handleMessage(workerId: string, message: WorkerMessage): void {
    const worker = this.#workers.get(workerId);
    if (!worker) return; // dropped between the frame arriving and this running
    worker.lastSeenAt = new Date().toISOString();

    switch (message.type) {
      case "register":
        return; // already registered on this connection; a repeat frame is ignored, not fatal
      case "heartbeat":
        this.#armHeartbeatWatchdog(worker);
        // The ack and the store write are both async now (the fleet record's
        // lastSeenAt has to land on disk), so a failing write can't be left
        // to become an unhandled rejection that takes the host down.
        void this.#handleHeartbeat(worker, message.leaseIds).catch((error: unknown) => {
          console.error(
            `[brevi] worker ${worker.name} (${worker.id}) heartbeat write failed: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        });
        return;
      case "dispatch-accepted":
        return; // acknowledgement only; the lease already exists from dispatch()
      case "dispatch-rejected": {
        const lease = this.#leaseFor(workerId, message.leaseId, message.runId, "dispatch-rejected");
        if (!lease) return;
        this.#settleLease(lease.id);
        this.#onRunRejected(lease.runId, message.reason, lease.kind);
        return;
      }
      case "run-patch": {
        const lease = this.#leaseFor(workerId, message.leaseId, message.runId, "run-patch");
        if (!lease) return;
        void this.#chainLeaseWrite(lease.id, () => this.#applyRunPatch(lease, message.patch));
        return;
      }
      case "run-event": {
        const lease = this.#leaseFor(workerId, message.leaseId, message.runId, "run-event");
        if (!lease) return;
        // The host is the sole owner of "artifact" events: it appends one
        // itself (via RunStore.addArtifact) once an artifact's bytes are
        // actually saved. A worker sending one here would double-log it; an
        // older worker that still sends them must be ignored, not obeyed.
        if (message.event.type === "artifact") return;
        this.#store.appendEvent({ ...message.event, runId: lease.runId });
        return;
      }
      case "run-artifact": {
        const lease = this.#leaseFor(workerId, message.leaseId, message.runId, "run-artifact");
        if (!lease) return;
        void this.#chainLeaseWrite(lease.id, () => this.#saveArtifact(lease, message));
        return;
      }
      case "run-memories": {
        const lease = this.#leaseFor(workerId, message.leaseId, message.runId, "run-memories");
        if (!lease) return;
        void this.#chainLeaseWrite(lease.id, () => this.#recordMemories(lease.runId, message));
        return;
      }
      case "run-complete": {
        const lease = this.#leaseFor(workerId, message.leaseId, message.runId, "run-complete");
        if (!lease) return;
        if (this.#completing.has(lease.id)) return; // a replay of one already being applied
        this.#completing.add(lease.id);
        void this.#completeRun(workerId, lease, message);
        return;
      }
      case "worker-log": {
        const line = `[brevi] worker ${worker.name}: ${message.message}`;
        if (message.level === "error") console.error(line);
        else if (message.level === "warn") console.warn(line);
        else console.log(line);
        return;
      }
      case "attach-data":
      case "attach-exit":
      case "attach-error":
        this.#handleAttachFrame(workerId, message);
        return;
    }
  }

  #handleAttachFrame(workerId: string, message: AttachDataMessage | AttachExitMessage | AttachErrorMessage): void {
    const session = this.#attachSessions.get(message.attachId);
    if (!session || session.workerId !== workerId) return;
    if (message.type === "attach-data") {
      session.onData(message.data);
      return;
    }
    this.#attachSessions.delete(message.attachId);
    if (message.type === "attach-exit") session.onExit(message.code);
    else session.onError(message.message);
  }

  /**
   * Apply a run-patch frame to the store: the flat fields go through
   * patchFromWire unchanged, while sandbox (present or not) is merged onto
   * what's already stored via mergeSandbox instead of overwriting it.
   */
  async #applyRunPatch(lease: Lease, patch: RunPatch): Promise<void> {
    const out: Partial<Omit<Run, "id">> = patchFromWire(patch);
    if ("sandbox" in patch) {
      const run = this.#store.get(lease.runId);
      out.sandbox = mergeSandbox(run?.sandbox ?? {}, patch.sandbox, lease.workerId);
    }
    await this.#store.update(lease.runId, out);
  }

  async #saveArtifact(lease: Lease, message: RunArtifactMessage): Promise<void> {
    if (!isSafePathSegment(message.artifact.name)) {
      console.warn(`[brevi] worker sent an unsafe artifact name for run ${lease.runId}; dropped`);
      return;
    }
    const dir = this.#store.artifactsDir(lease.runId);
    const path = resolveWithin(dir, message.artifact.name);
    if (!path) {
      console.warn(`[brevi] worker sent an artifact name that escapes the artifacts directory for run ${lease.runId}; dropped`);
      return;
    }
    const decoded = Buffer.from(message.data, "base64");
    if (decoded.length > WORKER_MAX_ARTIFACT_BYTES) {
      console.warn(`[brevi] worker sent an oversized artifact (${decoded.length} bytes) for run ${lease.runId}; dropped`);
      return;
    }
    await mkdir(dir, { recursive: true });
    await writeFile(path, decoded);
    await this.#store.addArtifact(lease.runId, message.artifact);
    let saved = this.#savedArtifacts.get(lease.id);
    if (!saved) {
      saved = new Set();
      this.#savedArtifacts.set(lease.id, saved);
    }
    saved.add(message.artifact.name);
  }

  async #recordMemories(runId: string, message: RunMemoriesMessage): Promise<void> {
    const { added, reaffirmed } = await this.#memories.record(message.repo, message.learned, {
      maxEntries: this.#config.memory.maxEntries,
      ident: message.ident,
    });
    if (added === 0 && reaffirmed === 0) return;
    this.#store.appendEvent({
      runId,
      ts: new Date().toISOString(),
      type: "log",
      stream: "system",
      text: `remembered ${added} new and reaffirmed ${reaffirmed} facts about ${message.repo}`,
    });
  }

  /**
   * run-complete is the last word on a dispatched run: apply its whole
   * terminal state (so a run whose earlier run-patch frames were lost to a
   * disconnect still lands correctly), reconcile its artifact manifest
   * against what actually got saved, ack it so the worker can drop the
   * lease, then settle the lease host-side and let the scheduler react. The
   * state write is awaited before the ack goes out, so the ack really does
   * mean "the host has it".
   */
  async #completeRun(workerId: string, lease: Lease, message: RunCompleteMessage): Promise<void> {
    // Everything this lease sent ahead of the completion has to have landed
    // before the manifest is reconciled against what was saved, and before
    // settleLease drops the lease's bookkeeping underneath a late write. The
    // chain deletes itself once drained, so this only waits when a write is
    // genuinely still in flight.
    const pendingWrites = this.#leaseWrites.get(lease.id);
    if (pendingWrites) await pendingWrites;
    await this.#applyRunComplete(lease, message);
    this.#reconcileArtifacts(lease, message.artifacts);
    const live = this.#workers.get(workerId);
    if (live) this.#send(live.socket, { type: "run-complete-ack", leaseId: lease.id, runId: lease.runId });
    this.#settleLease(lease.id);
    this.#onRunSettled(lease.runId);
  }

  /**
   * Append one lease-scoped write to that lease's chain. A failing write is
   * logged and swallowed so it cannot break the chain for the frames behind
   * it: losing one artifact must not strand the completion that follows.
   */
  #chainLeaseWrite(leaseId: string, write: () => Promise<void>): Promise<void> {
    const next: Promise<void> = (this.#leaseWrites.get(leaseId) ?? Promise.resolve())
      .then(write)
      .catch((error: unknown) => {
        console.error(`[brevi] lease ${leaseId} write failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        // Drop the chain once it has drained, so the map never accumulates
        // settled promises and a completion with nothing outstanding ahead of
        // it does not defer itself a tick waiting on one.
        if (this.#leaseWrites.get(leaseId) === next) this.#leaseWrites.delete(leaseId);
      });
    this.#leaseWrites.set(leaseId, next);
    return next;
  }

  async #applyRunComplete(lease: Lease, message: RunCompleteMessage): Promise<void> {
    const run = this.#store.get(lease.runId);
    const sandbox = mergeSandbox(run?.sandbox ?? {}, message.sandbox, lease.workerId);
    await this.#store.setStatus(lease.runId, message.outcome, {
      finishedAt: message.finishedAt,
      error: message.error,
      result: message.result,
      prUrl: message.prUrl,
      prState: message.prState,
      limit: message.limit,
      resumeAt: message.resumeAt,
      attempts: message.attempts,
      costs: message.costs,
      costTotals: message.costTotals,
      agentSessionId: message.agentSessionId,
      sandbox,
    });
  }

  /** Log every artifact the manifest claims but whose bytes this host never actually saved under the lease. */
  #reconcileArtifacts(lease: Lease, artifacts: ArtifactRef[]): void {
    const saved = this.#savedArtifacts.get(lease.id);
    for (const artifact of artifacts) {
      if (saved?.has(artifact.name)) continue;
      this.#store.appendEvent({
        runId: lease.runId,
        ts: new Date().toISOString(),
        type: "log",
        stream: "system",
        text: `artifact "${artifact.name}" did not reach the host`,
      });
    }
  }
}
