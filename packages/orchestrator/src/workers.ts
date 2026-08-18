import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import {
  parseWorkerMessage,
  registerMessageSchema,
  WORKER_HEARTBEAT_MS,
  WORKER_MAX_ARTIFACT_BYTES,
  WORKER_MAX_USAGE_SNAPSHOT_BYTES,
  WORKER_PROTOCOL_VERSION,
  type ArtifactRef,
  type AttachDataMessage,
  type AttachErrorMessage,
  type AttachExitMessage,
  type BreviConfig,
  type DispatchPrompts,
  type FleetWorkerDemand,
  type HostMessage,
  type RegisterMessage,
  type RepoConfig,
  type Run,
  type RunArtifactMessage,
  type RunCompleteMessage,
  type RunMemoriesMessage,
  type RunPatch,
  type RunUsageSnapshotMessage,
  type SandboxProviderName,
  type UsageDay,
  type WorkerDenyReason,
  type WorkerMessage,
  type WorkerState,
  type WorkerView,
} from "@brevi/shared";
import { CcusageArchive } from "./ccusageArchive.js";
import type { FleetStore, WorkerRecord } from "./fleet.js";
import { LeaseStore, type PersistedLease } from "./leases.js";
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
    return (
      (require("../package.json") as { version?: string }).version ?? "0.0.0"
    );
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

/** How often outstanding leases are checked for expiry. */
const LEASE_SWEEP_MS = 5_000;

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

/**
 * One outstanding dispatch, tracked host-side. Mirrors PersistedLease, plus
 * the fields bookkeeping needs but the persisted/wire forms don't: `kind` is
 * derived from the dispatch, and `expiresAt` is kept as epoch ms here (the
 * persisted and wire forms use ISO) because every comparison against it is
 * against `Date.now()`.
 *
 * A lease's deadline is `heartbeatTimeoutSeconds + reconnectGraceSeconds`
 * from the last contact (both from `config.fleet`). A worker heartbeats
 * every `WORKER_HEARTBEAT_MS`, so a healthy lease is renewed long before it
 * comes due; the sum is what a worker gets from its last heartbeat to being
 * written off, which is the same budget the socket watchdog
 * (heartbeatTimeoutSeconds) plus the reconnect grace window
 * (reconnectGraceSeconds) already gave it. It is renewed on register, on
 * heartbeat, and on every lease-scoped frame that passes the lease lookup
 * (#leaseFor). On disconnect the deadline is pulled in to
 * reconnectGraceSeconds from now: the worker is already known to be gone, so
 * it only gets its reconnect window, not a fresh full budget.
 */
interface Lease {
  id: string;
  runId: string;
  workerId: string;
  /** Last known display name of the owning worker, for log lines before it reconnects. */
  workerName: string;
  /**
   * What this dispatch asked the worker to do. Carried so a rejection or an
   * interruption can tell the scheduler which kind of work to rebuild when it
   * requeues the run: a follow-up that came back rejected must not be
   * retried as a fresh implementation against a PR that already exists.
   */
  kind: DispatchRequest["kind"];
  issuedAt: string;
  /** Epoch ms; see the class doc comment above for how this is computed and renewed. */
  expiresAt: number;
  /**
   * The durable replay watermark, and the only number a `lease-ack` ever
   * reports or the LeaseStore ever persists: the highest sequence number
   * such that every frame up to and including it has been applied to the run
   * store. Contiguous on purpose. Telling a worker a frame is applied is
   * what makes it drop that frame from its replay buffer, so this may never
   * step over a gap, and it moves strictly *after* a write lands (see
   * #markApplied), never when a frame is merely admitted.
   */
  appliedSeq: number;
  /**
   * Frames applied out of order, i.e. above `appliedSeq` because something
   * below them has not landed yet. Normally empty; it only fills when a
   * write fails and the frames behind it keep succeeding, and it drains the
   * moment the gap is filled by a retransmission. In memory only: after a
   * restart the worker replays everything above the persisted watermark
   * anyway.
   */
  appliedAhead: Set<number>;
  /** Frames admitted whose write has not settled yet, so a duplicate arriving meanwhile is not applied twice. In memory only. */
  inFlightSeqs: Set<number>;
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

/** Where a dispatch landed, or why nothing could take it (surfaced on the run card as the queue reason). */
export type DispatchOutcome =
  | { placed: true; workerId: string; workerName: string }
  | { placed: false; reason: string };

/** A restored lease handed back to the scheduler after a host restart; see WorkerRegistry.restore. */
export interface RestoredLease {
  leaseId: string;
  runId: string;
  workerId: string;
  workerName: string;
  kind: "implementation" | "follow-up";
}

export interface WorkerRegistryOptions {
  config: BreviConfig;
  store: RunStore;
  memories: MemoryStore;
  /** Who is enrolled, and the credentials that prove it; see fleet.ts. */
  fleet: FleetStore;
  /** Persisted leases; injectable so tests can point it at a temp directory. Defaults to a LeaseStore on LEASES_PATH. */
  leases?: LeaseStore;
  /** Where worker usage snapshots are archived; injectable so tests can point it at a temp directory. Defaults to a CcusageArchive on CCUSAGE_DIR. */
  usage?: CcusageArchive;
  /** A run reached a terminal or waiting state; the caller re-arms whatever follow-on timer that implies and tries to dispatch more of the queue. */
  onRunSettled(runId: string): void;
  /** A worker rejected (or lost) a dispatch before doing any work; the caller requeues the run. */
  onRunRejected(
    runId: string,
    reason: string,
    kind: DispatchRequest["kind"],
  ): void;
  /**
   * A dispatched run lost its worker for good (lease expired, or a reconnect
   * no longer claims it). Nothing failed the run: the scheduler decides
   * whether the dead worker already opened a PR worth adopting, or the run
   * goes back on the queue for a fresh dispatch.
   */
  onRunInterrupted(
    runId: string,
    reason: string,
    kind: DispatchRequest["kind"],
  ): void;
}

interface WorkerRegistryEvents {
  workers: [WorkerView[]];
}

/** What cancel() managed to do: "unknown" when the run has no active lease at all. */
export type CancelOutcome = "sent" | "pending" | "unknown";

/** A mutation the local worker refuses (rename, revoke). The scheduler maps exactly this to a 400; other failures stay server errors. */
export class LocalWorkerRefusalError extends Error {}

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
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "register"
  );
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
function mergeSandbox(
  current: Run["sandbox"],
  patch: SandboxWirePatch | null | undefined,
  workerId: string,
): Run["sandbox"] {
  const next: Run["sandbox"] = { ...current, workerId };
  if (!patch) return next;
  if (patch.provider !== undefined) next.provider = patch.provider ?? undefined;
  if (patch.id !== undefined) next.id = patch.id ?? undefined;
  if (patch.retainedUntil !== undefined)
    next.retainedUntil = patch.retainedUntil ?? undefined;
  return next;
}

export class WorkerRegistry extends EventEmitter<WorkerRegistryEvents> {
  readonly #config: BreviConfig;
  readonly #store: RunStore;
  readonly #memories: MemoryStore;
  readonly #fleet: FleetStore;
  readonly #leaseStore: LeaseStore;
  readonly #usage: CcusageArchive;
  readonly #onRunSettled: (runId: string) => void;
  readonly #onRunRejected: (
    runId: string,
    reason: string,
    kind: DispatchRequest["kind"],
  ) => void;
  readonly #onRunInterrupted: (
    runId: string,
    reason: string,
    kind: DispatchRequest["kind"],
  ) => void;
  /** Backstop expiry: catches leases whose in-process grace timer no longer exists, e.g. after a host restart (see restore()). */
  readonly #sweepTimer: NodeJS.Timeout;

  #workers = new Map<string, ConnectedWorker>();
  #leases = new Map<string, Lease>();
  #leaseByRun = new Map<string, string>();
  #grace = new Map<string, GraceEntry>();
  #heartbeatTimers = new Map<string, NodeJS.Timeout>();
  #attachSessions = new Map<string, AttachSessionEntry>();
  /** In-flight usage-report requests awaiting a worker's answer, by requestId. */
  #usageRequests = new Map<
    string,
    {
      workerId: string;
      timer: NodeJS.Timeout;
      resolve: (days: UsageDay[]) => void;
      reject: (error: Error) => void;
    }
  >();
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
   * Every other piece of async work started with `void` rather than awaited:
   * registration, disconnect handling, heartbeat writes, stranded leases,
   * completions. Tracked only so `drain` can wait for them; each entry
   * removes itself when it settles, so this stays empty in the steady state.
   */
  #inFlightWork = new Set<Promise<unknown>>();
  /**
   * Leases whose completion is being applied. Settling is async, so two
   * run-complete frames for one lease can both pass the lease lookup before
   * either settles, and a duplicate is expected by design: a worker replays a
   * completion it holds no acknowledgement for, which is exactly what happens
   * when the ack itself is lost. Completing twice would double the terminal
   * events, the artifact reconciliation and the scheduler's settled callback.
   */
  #completing = new Set<string>();
  /**
   * Completions that arrived while a frame below them was still missing,
   * parked until the gap closes. Keyed by lease; a lease has at most one,
   * since #completing stops a second from being taken.
   */
  #pendingCompletions = new Map<
    string,
    { workerId: string; message: RunCompleteMessage }
  >();
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
    this.#leaseStore = options.leases ?? new LeaseStore();
    this.#usage = options.usage ?? new CcusageArchive();
    this.#onRunSettled = options.onRunSettled;
    this.#onRunRejected = options.onRunRejected;
    this.#onRunInterrupted = options.onRunInterrupted;

    this.#sweepTimer = setInterval(
      () => this.#sweepExpiredLeases(),
      LEASE_SWEEP_MS,
    );
    this.#sweepTimer.unref();
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
    let disconnected = false;
    /**
     * The one path out of this connection, so a close and a registration
     * finishing after it cannot both run it: the entry is published mid-flight
     * now (see the #handleRegister call below), which puts both in a position
     * to notice the same drop and arm two grace windows for one worker.
     */
    const disconnect = (): void => {
      if (disconnected || !entry) return;
      disconnected = true;
      this.#handleDisconnect(entry);
    };
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
          const reason = issue
            ? issue.path.length
              ? `${issue.path.join(".")}: ${issue.message}`
              : issue.message
            : "malformed register frame";
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
        //
        // The entry arrives through the callback rather than only from the
        // resolved promise, because #handleRegister keeps working after it
        // has sent `registered` (it drains each lease's writes before acking
        // them). The worker starts heartbeating and flushing its queue the
        // instant that frame lands, so waiting for the promise would drop
        // every one of those frames on the floor.
        const registration = this.#handleRegister(
          socket,
          result.data,
          address,
          (installed) => {
            entry = installed;
          },
        ).then(
          (registered) => {
            registering = false;
            if (!registered) {
              socket.close(); // #handleRegister already sent `rejected`
              return;
            }
            // The socket went away while its registration was still in
            // flight, so its "close" had nothing to clean up at the time;
            // run that path now against the connection just installed.
            if (closed) disconnect();
          },
          (error: unknown) => {
            registering = false;
            console.error(
              `[brevi] worker registration failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            this.#reject(
              socket,
              "malformed",
              "registration could not be completed",
            );
            socket.close();
          },
        );
        this.#track(registration);
        return;
      }
      const message = parseWorkerMessage(parsed);
      if (!message) return; // malformed frame; ignored rather than fatal, this connection is already registered
      this.#handleMessage(entry.id, message);
    });

    socket.on("close", () => {
      closed = true;
      clearTimeout(pendingTimer);
      disconnect();
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
      if (record.local) view.local = true;
      // What the worker reported on this connection beats what it reported on
      // its last one: a worker restarted with a different concurrency says so
      // at register time.
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

  /**
   * Whether a durable credential belongs to this worker, for a caller that
   * arrives over HTTP rather than on the worker channel (see
   * WORKER_DEMAND_PATH). The same constant-time comparison the channel's own
   * register uses; nothing about the worker is returned, only the verdict.
   */
  authenticate(workerId: string, credential: string): boolean {
    return this.#fleet.authenticate(workerId, credential) !== null;
  }

  /**
   * Mint or refresh the host's own local worker (see
   * FleetStore.ensureLocalWorker), announced through the same "workers" emit
   * every other mutation here uses.
   */
  async ensureLocalWorker(name: string): Promise<{ workerId: string; credential: string }> {
    const result = await this.#fleet.ensureLocalWorker(name);
    this.#emitWorkers();
    return result;
  }

  /**
   * Rename an enrolled worker. `name` is trusted to already be sanitized and
   * non-empty. Refused for the local worker, which always presents as "This
   * machine"; only ensureLocalWorker touches its record's name.
   */
  async rename(id: string, name: string): Promise<boolean> {
    if (this.#fleet.get(id)?.local) {
      throw new LocalWorkerRefusalError("the local worker cannot be renamed; it always presents as this machine");
    }
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
   * the race that closes. Refused for the local worker; draining it is the
   * equivalent operation.
   */
  async revoke(id: string): Promise<boolean> {
    return this.#serialize(async () => {
      if (this.#fleet.get(id)?.local) {
        throw new LocalWorkerRefusalError("the local worker cannot be revoked; drain it instead");
      }
      if (!(await this.#fleet.revoke(id))) return false;
      const live = this.#workers.get(id);
      if (live) {
        this.#send(live.socket, {
          type: "revoked",
          reason: "This worker's enrollment was revoked.",
        });
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
   * Sum of every connected worker's free capacity (maxConcurrency minus its
   * current lease count, floored at 0), draining workers excluded for the
   * same reason `capacity` excludes them: a drained machine's idle slots are
   * not room the scheduler may plan against.
   */
  spareCapacity(): number {
    let total = 0;
    for (const worker of this.#workers.values()) {
      if (this.#isDraining(worker.id)) continue;
      total += Math.max(
        0,
        worker.capabilities.maxConcurrency -
          this.#leasesForWorker(worker.id).length,
      );
    }
    return total;
  }

  /** Live state of one worker, for a supervisor deciding whether its machine may sleep. */
  workerDemand(workerId: string): FleetWorkerDemand {
    let attachSessions = 0;
    for (const session of this.#attachSessions.values()) {
      if (session.workerId === workerId) attachSessions++;
    }
    return {
      id: workerId,
      connected: this.#workers.has(workerId),
      // An id this host has no record of reads as draining rather than
      // active: whatever it is, the scheduler will never dispatch to it, and
      // that is exactly what a supervisor asking "should I be awake" needs to
      // hear. The demand route authenticates first, so in practice only a
      // worker revoked mid-poll takes this branch.
      state: this.#fleet.get(workerId)?.state ?? "draining",
      activeRuns: this.#leasesForWorker(workerId).length,
      attachSessions,
    };
  }

  /**
   * Dispatch one run to whichever connected worker placement picks (see
   * #placeWorker: isolation first, then free capacity, then worker id).
   * Returns why nothing was sent, surfaced on the run card as the queue
   * reason, when no worker can currently take it.
   *
   * The lease is taken in memory straight away, so capacity accounting and
   * the outcome are immediate, but the dispatch frame itself waits for the
   * claim to reach disk. Nobody may be executing a run this host has no
   * durable record of: a crash in that window would leave the next boot
   * dispatching it a second time while the first worker was still on it.
   */
  dispatch(payload: DispatchRequest): DispatchOutcome {
    const placement = this.#placeWorker(payload.config.agent.command);
    if ("reason" in placement)
      return { placed: false, reason: placement.reason };
    const target = placement.worker;

    const issuedAt = new Date().toISOString();
    const leaseId = randomUUID();
    const lease: Lease = {
      id: leaseId,
      runId: payload.run.id,
      workerId: target.id,
      workerName: target.name,
      kind: payload.kind,
      issuedAt,
      expiresAt: this.#leaseDeadline(),
      appliedSeq: 0,
      appliedAhead: new Set(),
      inFlightSeqs: new Set(),
    };
    this.#leases.set(leaseId, lease);
    this.#leaseByRun.set(payload.run.id, leaseId);

    const run: Run = {
      ...payload.run,
      sandbox: { ...payload.run.sandbox, workerId: target.id },
    };
    this.#track(this.#store.update(payload.run.id, { sandbox: run.sandbox }));

    this.#track(
      this.#leaseStore.putDurable(this.#toPersisted(lease)).then(
        () => {
          // The lease can have been settled while the claim was being written
          // (a revoke, a shutdown); sending now would hand out work nothing is
          // tracking any more.
          if (this.#leases.get(leaseId) !== lease) return;
          this.#send(target.socket, {
            type: "dispatch",
            lease: {
              id: leaseId,
              runId: payload.run.id,
              issuedAt,
              expiresAt: new Date(lease.expiresAt).toISOString(),
            },
            kind: payload.kind,
            run,
            repoKey: payload.repoKey,
            repo: payload.repo,
            config: payload.config,
            prompts: payload.prompts,
          });
        },
        (error: unknown) => {
          // The claim never landed, so the dispatch must not go out: give the
          // lease up and hand the run back to the scheduler to queue again.
          const reason = `the lease could not be persisted: ${error instanceof Error ? error.message : String(error)}`;
          console.error(
            `[brevi] not dispatching run ${payload.run.id}: ${reason}`,
          );
          this.#settleLease(leaseId);
          this.#onRunRejected(payload.run.id, reason, payload.kind);
        },
      ),
    );
    return { placed: true, workerId: target.id, workerName: target.name };
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
  openAttach(
    runId: string,
    options: AttachSessionOptions,
  ): AttachSession | undefined {
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
        if (live)
          this.#send(live.socket, { type: "attach-input", attachId, data });
      },
      resize: (cols, rows) => {
        const live = this.#workers.get(workerId);
        if (live)
          this.#send(live.socket, {
            type: "attach-resize",
            attachId,
            cols,
            rows,
          });
      },
      close: () => {
        const live = this.#workers.get(workerId);
        if (live) this.#send(live.socket, { type: "attach-close", attachId });
        this.#attachSessions.delete(attachId);
      },
    };
  }

  /**
   * Ask a connected worker for its machine's daily usage (ccusage's daily
   * report, read by the daemon on its own machine). Rejects when the worker
   * isn't connected, answers with an error, or doesn't answer in time; the
   * generous timeout covers a first-ever read that has to install ccusage.
   */
  requestUsage(workerId: string, timeoutMs = 150_000): Promise<UsageDay[]> {
    const live = this.#workers.get(workerId);
    if (!live) return Promise.reject(new Error("worker is not connected"));
    const requestId = randomUUID();
    return new Promise<UsageDay[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#usageRequests.delete(requestId);
        reject(new Error("the worker did not answer in time"));
      }, timeoutMs);
      timer.unref();
      this.#usageRequests.set(requestId, { workerId, timer, resolve, reject });
      this.#send(live.socket, { type: "usage-report", requestId });
    });
  }

  /**
   * Wait for every write this registry still has in flight to land.
   *
   * Most of what it writes is started with `void`, deliberately: a frame
   * arriving on a socket cannot be awaited by whoever sent it, and a failing
   * write must not become an unhandled rejection. The cost is that `stop`
   * returning says nothing about the disk, so a shutdown, or a test tearing
   * its temp directory down, can race a run's final state on its way out.
   * This is how a caller that needs those writes to have happened says so.
   *
   * Looped rather than awaited once, because these chains feed each other: a
   * lease write queues a run-store write, and completing a run can strand
   * another lease. Settling is what matters, not succeeding, so a write that
   * fails still counts as drained.
   */
  async drain(): Promise<void> {
    // Bounded so a pathological chain that keeps queueing work cannot hang a
    // shutdown forever; ten rounds is far past anything the protocol produces.
    for (let round = 0; round < 10; round += 1) {
      const pending = [...this.#inFlightWork, ...this.#leaseWrites.values()];
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
    await this.#store.flush();
  }

  /** Register a `void`-ed promise with `drain`, and forget it once it settles. */
  #track(work: Promise<unknown>): void {
    const tracked = work.finally(() => this.#inFlightWork.delete(tracked));
    this.#inFlightWork.add(tracked);
  }

  /**
   * Take over the leases a previous process left behind, before any worker
   * has connected. Leases whose run is gone or already terminal are dropped;
   * the rest are re-registered with a fresh reconnect deadline, so a worker
   * that dials back in resumes reporting against the same lease and one that
   * never comes back expires normally (via the sweep timer, since there is
   * no in-process disconnect timer for a lease that survived a restart).
   * Returns what was taken over, for the scheduler's recovery pass.
   */
  async restore(): Promise<RestoredLease[]> {
    const persisted = await this.#leaseStore.init();
    const restored: RestoredLease[] = [];
    for (const entry of persisted) {
      const run = this.#store.get(entry.runId);
      if (!run || isTerminal(run.status)) {
        this.#leaseStore.delete(entry.id);
        continue;
      }
      const lease: Lease = {
        id: entry.id,
        runId: entry.runId,
        workerId: entry.workerId,
        workerName: entry.workerName,
        kind: entry.kind,
        issuedAt: entry.issuedAt,
        expiresAt: Date.now() + this.#config.fleet.reconnectGraceSeconds * 1000,
        appliedSeq: entry.appliedSeq,
        // Nothing is applied out of order or in flight in a process that has
        // only just booted: the worker replays everything above the
        // persisted watermark, and all of it is applied afresh.
        appliedAhead: new Set(),
        inFlightSeqs: new Set(),
      };
      this.#leases.set(lease.id, lease);
      this.#leaseByRun.set(lease.runId, lease.id);
      this.#leaseStore.put(this.#toPersisted(lease));
      restored.push({
        leaseId: lease.id,
        runId: lease.runId,
        workerId: lease.workerId,
        workerName: lease.workerName,
        kind: lease.kind,
      });
    }
    return restored;
  }

  /**
   * Close every socket and clear the host's in-process timers. Deliberately
   * does **not** cancel or settle any lease: a host shutdown is now a
   * survivable event, which is the whole point of this ticket. Workers keep
   * executing whatever they hold, their leases are on disk, and the next
   * boot's restore() re-adopts them. Awaits LeaseStore.flush() so any
   * watermark still sitting behind its debounce reaches disk before the
   * process actually exits.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    for (const worker of this.#workers.values()) worker.socket.terminate();
    this.#workers.clear();
    for (const grace of this.#grace.values()) clearTimeout(grace.timer);
    this.#grace.clear();
    for (const timer of this.#heartbeatTimers.values()) clearTimeout(timer);
    this.#heartbeatTimers.clear();
    clearInterval(this.#sweepTimer);
    this.#cancelIntents.clear();
    this.#savedArtifacts.clear();
    await this.#leaseStore.flush();
  }

  // --- internals -----------------------------------------------------------

  #workerForRun(runId: string): ConnectedWorker | undefined {
    const workerId = this.#store.get(runId)?.sandbox.workerId;
    return workerId ? this.#workers.get(workerId) : undefined;
  }

  #leasesForWorker(workerId: string): Lease[] {
    return [...this.#leases.values()].filter(
      (lease) => lease.workerId === workerId,
    );
  }

  /** Whether the store has this worker parked out of rotation. */
  #isDraining(workerId: string): boolean {
    return this.#fleet.get(workerId)?.state === "draining";
  }

  /** Free capacity (maxConcurrency minus current lease count) a worker has right now. */
  #freeCapacity(worker: ConnectedWorker): number {
    return (
      worker.capabilities.maxConcurrency -
      this.#leasesForWorker(worker.id).length
    );
  }

  /**
   * Choose where a dispatch lands, or say why nothing can take it right now.
   * In order: no worker connected at all; every connected worker drained out
   * of rotation; no remaining worker has the requested agent command; every
   * compatible worker is at capacity. What's left is ranked by most free
   * capacity, then worker id, so the choice is stable and testable, and the
   * first one wins.
   *
   * Draining workers never appear among the candidates: they keep the leases
   * they already hold and report them normally, they are simply never handed
   * anything new (see #isDraining).
   */
  #placeWorker(agentCommand: string): { worker: ConnectedWorker } | { reason: string } {
    if (this.#workers.size === 0) return { reason: "no workers are connected" };

    const notDraining = [...this.#workers.values()].filter((worker) => !this.#isDraining(worker.id));
    if (notDraining.length === 0) {
      const n = this.#workers.size;
      return {
        reason:
          n === 1
            ? "the 1 connected worker is draining"
            : `all ${n} connected workers are draining`,
      };
    }

    const available = notDraining.filter(
      (worker) => worker.capabilities.provider === "bwrap" || worker.capabilities.provider === "seatbelt",
    );
    if (available.length === 0) {
      return { reason: "no connected worker can execute isolated runs" };
    }

    const withAgent = available.filter((worker) => worker.capabilities.agentCommands.includes(agentCommand));
    if (withAgent.length === 0) {
      return { reason: `no connected worker has the agent command "${agentCommand}"` };
    }

    const withCapacity = withAgent.filter(
      (worker) => this.#freeCapacity(worker) > 0,
    );
    if (withCapacity.length === 0) {
      const n = withAgent.length;
      const reason =
        n === 1
          ? "all 1 connected worker is at capacity"
          : `all ${n} connected workers are at capacity`;
      return { reason };
    }

    const ranked = [...withCapacity].sort((a, b) => {
      const freeDiff = this.#freeCapacity(b) - this.#freeCapacity(a);
      return freeDiff !== 0 ? freeDiff : a.id.localeCompare(b.id);
    });
    return { worker: ranked[0]! };
  }

  /** heartbeatTimeoutSeconds + reconnectGraceSeconds from now, in epoch ms; see the Lease doc comment for why. */
  #leaseDeadline(): number {
    return (
      Date.now() +
      (this.#config.fleet.heartbeatTimeoutSeconds +
        this.#config.fleet.reconnectGraceSeconds) *
        1000
    );
  }

  #toPersisted(lease: Lease): PersistedLease {
    return {
      id: lease.id,
      runId: lease.runId,
      workerId: lease.workerId,
      workerName: lease.workerName,
      kind: lease.kind,
      issuedAt: lease.issuedAt,
      expiresAt: new Date(lease.expiresAt).toISOString(),
      appliedSeq: lease.appliedSeq,
    };
  }

  /**
   * Push a lease's deadline back out to a fresh full budget and persist the
   * change (debounced, see LeaseStore). Called on register, on heartbeat,
   * and from #leaseFor for every lease-scoped frame that resolves to a valid
   * lease, so a lease in active use never comes due.
   */
  #renewLease(lease: Lease): void {
    lease.expiresAt = this.#leaseDeadline();
    this.#leaseStore.put(this.#toPersisted(lease));
  }

  /**
   * Tell a worker how far this host has applied one lease's reporting stream,
   * and when the lease comes due. The deadline is what lets the worker fence
   * itself: it stops the run on its own once this passes with no further
   * contact, which is the only protection against a partitioned worker that
   * never reconnects to be told (see leaseLostMessageSchema).
   */
  #sendLeaseAck(socket: WebSocket, lease: Lease): void {
    this.#send(socket, {
      type: "lease-ack",
      leaseId: lease.id,
      runId: lease.runId,
      seq: lease.appliedSeq,
      expiresAt: new Date(lease.expiresAt).toISOString(),
    });
  }

  /** Pull a lease's deadline in to just its reconnect grace window; called when the lease's worker is known to be gone. */
  #pullInLeaseDeadline(lease: Lease): void {
    lease.expiresAt =
      Date.now() + this.#config.fleet.reconnectGraceSeconds * 1000;
    this.#leaseStore.put(this.#toPersisted(lease));
  }

  /**
   * The replay gate the six reporting frame types (run-patch, run-event,
   * run-artifact, run-memories, run-usage-snapshot, run-complete) go
   * through after #leaseFor. A
   * worker replays its buffered frames after a reconnect (see
   * WORKER_REPLAY_BUFFER_LIMIT); without this the console, and the memory
   * and artifact stores, would gain a duplicate copy of everything the host
   * already applied. A frame with no seq predates buffered replay and is
   * always applied.
   *
   * Admission is exact rather than a high-water mark, because a frame whose
   * write failed has to be admissible again when the worker retransmits it:
   * a frame is refused only when it is genuinely already accounted for, i.e.
   * below the contiguous watermark, applied out of order above it, or
   * currently being written. Anything else is a gap the host still wants,
   * whether it arrives on a reconnect's replay or on a live connection (see
   * the worker's stalled-ack retransmission in connection.ts).
   *
   * Admission is not application: the watermark a `lease-ack` reports moves
   * later, in #markApplied, once the write has landed.
   */
  #admitFrame(lease: Lease, seq: number | undefined): boolean {
    if (seq === undefined) return true;
    if (seq <= lease.appliedSeq) return false; // below the watermark: applied, and said so
    if (lease.appliedAhead.has(seq)) return false; // applied, just not contiguous yet
    if (lease.inFlightSeqs.has(seq)) return false; // admitted already, write still running
    lease.inFlightSeqs.add(seq);
    return true;
  }

  /**
   * Run one admitted frame's write on its lease's chain and record it as
   * applied only if it actually lands.
   *
   * This ordering is the whole point. The watermark is what a `lease-ack`
   * reports, and a worker drops every frame at or below it from its replay
   * buffer, so a watermark that ran ahead of the writes would let a host
   * crash (or a failing write) lose a mutation the worker had already been
   * told was safe to forget. Recording behind the write means the worst case
   * is the opposite one: the worker resends a frame the host did apply, and
   * #admitFrame absorbs it.
   */
  #applyReported(
    lease: Lease,
    seq: number | undefined,
    write: () => Promise<void>,
  ): void {
    this.#track(
      this.#chainLeaseWrite(lease.id, async () => {
        try {
          await write();
        } catch (error) {
          // Nothing is recorded, so this seq becomes a gap: the watermark stops
          // below it however many frames behind it succeed, and #admitFrame
          // will take it again when the worker resends it.
          if (seq !== undefined) lease.inFlightSeqs.delete(seq);
          throw error; // #chainLeaseWrite logs it and keeps the chain alive for the frames behind
        }
        this.#markApplied(lease, seq);
      }),
    );
  }

  /**
   * Record one frame as applied and pull the contiguous watermark up over
   * everything that is now unbroken, persisting it (debounced, see
   * LeaseStore) only when it actually moved. A frame applied while an
   * earlier one is still missing just waits in `appliedAhead`; filling that
   * gap later is what releases the whole run of them at once.
   */
  #markApplied(lease: Lease, seq: number | undefined): void {
    if (seq === undefined) return;
    lease.inFlightSeqs.delete(seq);
    if (seq <= lease.appliedSeq) return;
    lease.appliedAhead.add(seq);
    const before = lease.appliedSeq;
    while (lease.appliedAhead.delete(lease.appliedSeq + 1))
      lease.appliedSeq += 1;
    if (lease.appliedSeq === before) return;
    this.#leaseStore.put(this.#toPersisted(lease));
    // The watermark only ever moves here, so this is the one place a
    // completion parked behind a gap can discover the gap is closed.
    this.#maybeFinishPendingCompletion(lease);
  }

  /**
   * The worker has told us it no longer holds anything at or below
   * `throughSeq` for this lease, so those frames are never arriving: step the
   * watermark over the whole range and record the loss against the run.
   *
   * Without this the two halves of the design would deadlock. The watermark
   * is the contiguous applied prefix and refuses to cross a missing sequence
   * number; the worker's replay buffer is bounded and drops frames when a
   * host stays unreachable for long enough. Whoever gives way has to say so,
   * and it has to be the side that knows: the worker, which is the only one
   * that can tell "not yet" from "never".
   */
  #skipLeaseGap(lease: Lease, throughSeq: number, dropped: number): void {
    if (throughSeq <= lease.appliedSeq) return; // nothing new to give up on
    const from = lease.appliedSeq + 1;
    console.warn(
      `[brevi] worker ${lease.workerName} dropped ${dropped} report frame(s) for run ${lease.runId} ` +
        `(sequence ${from}-${throughSeq}) while this host was unreachable`,
    );
    this.#store.appendEvent({
      runId: lease.runId,
      ts: new Date().toISOString(),
      type: "log",
      stream: "system",
      text: `${dropped} log or artifact frame(s) were dropped by the worker while brevi was unreachable`,
    });
    lease.appliedSeq = throughSeq;
    for (const seq of Array.from(lease.appliedAhead)) {
      if (seq <= throughSeq) lease.appliedAhead.delete(seq);
    }
    while (lease.appliedAhead.delete(lease.appliedSeq + 1))
      lease.appliedSeq += 1;
    this.#leaseStore.put(this.#toPersisted(lease));
    this.#maybeFinishPendingCompletion(lease);
  }

  /**
   * Wait for everything already chained for a lease to finish, so a watermark
   * read straight afterwards is a settled fact rather than a guess: a worker
   * told a stale one on reconnect would replay frames the host is in the
   * middle of writing. The chain deletes itself once drained (see
   * #chainLeaseWrite), so this returns immediately when nothing is in flight;
   * the loop only exists because a write could be chained behind the one
   * being awaited.
   */
  async #drainLeaseWrites(leaseId: string): Promise<void> {
    for (let guard = 0; guard < 5; guard++) {
      const pending = this.#leaseWrites.get(leaseId);
      if (!pending) return;
      await pending;
    }
  }

  /** Expire every lease whose deadline has passed; the sweep's backstop, see LEASE_SWEEP_MS. */
  #sweepExpiredLeases(): void {
    const now = Date.now();
    for (const lease of this.#leases.values()) {
      if (lease.expiresAt > now) continue;
      const name = this.#workers.get(lease.workerId)?.name ?? lease.workerName;
      this.#track(
        this.#expireLease(lease.id, `the worker ${name} stopped reporting`),
      );
    }
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
   *
   * `onInstalled` fires the moment this connection has an identity and is
   * about to be told so, which is before this method returns: the tail of a
   * registration (draining and acking each lease) happens after `registered`
   * has gone out, and the worker is already talking by then. accept() uses it
   * to start routing that traffic instead of dropping it.
   */
  async #handleRegister(
    socket: WebSocket,
    message: RegisterMessage,
    address: string | undefined,
    onInstalled: (entry: ConnectedWorker) => void,
  ): Promise<ConnectedWorker | undefined> {
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
          this.#reject(
            socket,
            result.error,
            "the pairing token was not accepted",
          );
          return undefined;
        }
        record = result.worker;
        credential = result.credential;
      } else {
        const found = this.#fleet.authenticate(auth.workerId, auth.secret);
        if (!found) {
          console.warn(
            `[brevi] rejected worker ${auth.workerId}: unknown or revoked credential`,
          );
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
        console.log(
          `[brevi] worker ${entry.name} (${entry.id}) reconnected on a new socket; closing the previous one`,
        );
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
      // without reporting, or the process restarted mid-run) and is expired
      // right away rather than waiting out a grace window reconnection already
      // answered. Leases it does still claim are left exactly as they were;
      // its buffered reporting resumes on this connection.
      const claimed = new Set(message.activeLeases.map((lease) => lease.id));
      for (const lease of this.#leasesForWorker(workerId)) {
        if (!claimed.has(lease.id))
          this.#track(
            this.#expireLease(
              lease.id,
              `worker ${entry.name} reconnected without this run`,
            ),
          );
      }

      // Registration is complete as far as this connection's identity goes:
      // the entry is installed and every frame from here on can be attributed
      // to it. Published before `registered` goes out, because that frame is
      // what makes the worker start heartbeating and flush whatever it queued
      // while disconnected, and the lease reconciliation below still has
      // awaits left in it.
      this.#armHeartbeatWatchdog(entry);
      onInstalled(entry);

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

      // The other direction, and the fence around a re-dispatched run: a lease
      // the worker still claims that this host has no record of (already
      // settled, or expired and handed to somebody else while this worker was
      // partitioned) is dead, and the worker may well still be executing it.
      // Telling it to stop is what stops two workers pushing the same branch;
      // merely dropping the claim, which is all the old run-complete-ack did,
      // left the execution running.
      for (const claimedLease of message.activeLeases) {
        if (this.#leases.has(claimedLease.id)) continue;
        console.warn(
          `[brevi] worker ${entry.name} (${entry.id}) reconnected still claiming lease ${claimedLease.id} for run ` +
            `${claimedLease.runId}, which this host no longer holds; telling it to abort`,
        );
        this.#send(socket, {
          type: "lease-lost",
          leaseId: claimedLease.id,
          runId: claimedLease.runId,
          reason:
            "this lease expired while the worker was unreachable; the run is no longer yours",
        });
      }
      // A cancel requested while this worker was disconnected never reached it;
      // replay it now so a reconnecting worker is aborted before it resumes
      // normal run-patch / run-complete reporting.
      for (const lease of this.#leasesForWorker(workerId)) {
        if (this.#cancelIntents.has(lease.id)) {
          this.#send(socket, {
            type: "cancel",
            leaseId: lease.id,
            runId: lease.runId,
          });
        }
      }
      // Renew every lease this host still holds for this worker, and tell it
      // how far the host got applying its reporting stream, so the worker
      // trims its replay buffer before resuming rather than holding it back
      // waiting for an ack that was already implied by the reconnect.
      //
      // The writes are drained first so the number sent is a settled fact:
      // frames admitted on the dead socket may still have been mid-write when
      // it dropped, and acking before they land would name a watermark the
      // store has not reached and send the worker replaying over the top of
      // writes still in progress.
      for (const lease of this.#leasesForWorker(workerId)) {
        await this.#drainLeaseWrites(lease.id);
        // The lease can have been settled or expired while that drained.
        if (!this.#leases.has(lease.id)) continue;
        this.#renewLease(lease);
        this.#sendLeaseAck(socket, lease);
      }

      this.#emitWorkers();
      return entry;
    });
  }

  /** (Re)arm the timer that drops a worker for going quiet; called on register and on every heartbeat. */
  #armHeartbeatWatchdog(entry: ConnectedWorker): void {
    const existing = this.#heartbeatTimers.get(entry.id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      console.warn(
        `[brevi] worker ${entry.name} (${entry.id}) missed its heartbeat; dropping the connection`,
      );
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
  async #handleHeartbeat(
    worker: ConnectedWorker,
    leaseIds: string[],
  ): Promise<void> {
    const claimed = [...leaseIds].sort().join(",");
    const changed = claimed !== worker.claimedLeases;
    worker.claimedLeases = claimed;
    const record = await this.#fleet.touch(worker.id, {
      lastSeenAt: worker.lastSeenAt,
    });
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
      this.#send(worker.socket, {
        type: "revoked",
        reason: "This worker's enrollment was revoked.",
      });
      this.#workers.delete(worker.id);
      worker.socket.close();
      this.#emitWorkers();
      return;
    }
    this.#send(worker.socket, {
      type: "heartbeat-ack",
      ts: new Date().toISOString(),
      state: record.state,
    });
    if (changed || Date.now() - this.#lastEmitAt >= HEARTBEAT_BROADCAST_MS)
      this.#emitWorkers();
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
    // Settle this worker's in-flight usage requests now: the answer can no
    // longer arrive on this socket, and waiting out the timeout would hold
    // /api/usage open for a disconnect that is already known.
    for (const [requestId, request] of this.#usageRequests) {
      if (request.workerId !== entry.id) continue;
      clearTimeout(request.timer);
      this.#usageRequests.delete(requestId);
      request.reject(new Error("the worker disconnected before answering"));
    }
    this.#emitWorkers();

    const leases = this.#leasesForWorker(entry.id);
    if (leases.length === 0) return;
    const graceSeconds = this.#config.fleet.reconnectGraceSeconds;
    console.warn(
      `[brevi] worker ${entry.name} (${entry.id}) disconnected with ${leases.length} run(s) in flight; ` +
        `giving it ${graceSeconds}s to reconnect before treating them as interrupted`,
    );
    // The worker is already known to be gone, so its leases only get their
    // reconnect window, not a fresh full budget; see the Lease doc comment.
    for (const lease of leases) this.#pullInLeaseDeadline(lease);
    const leaseIds = leases.map((lease) => lease.id);
    const timer2 = setTimeout(() => {
      this.#grace.delete(entry.id);
      for (const leaseId of leaseIds)
        this.#track(
          this.#expireLease(
            leaseId,
            `the worker ${entry.name} stopped reporting`,
          ),
        );
    }, graceSeconds * 1000);
    timer2.unref();
    this.#grace.set(entry.id, { leaseIds: new Set(leaseIds), timer: timer2 });
  }

  /**
   * A lease's worker is gone for good (grace window expired with no
   * reconnect, the sweep found it past its deadline, or the reconnect itself
   * no longer claims it): settle the lease's bookkeeping and, unless the run
   * already reached a terminal state on its own (a run-complete that raced
   * the disconnect), hand it to onRunInterrupted. This never fails the run
   * itself: the scheduler decides whether the dead worker already opened a
   * PR worth adopting, or the run goes back on the queue for a fresh
   * dispatch.
   */
  async #expireLease(leaseId: string, reason: string): Promise<void> {
    const lease = this.#leases.get(leaseId);
    if (!lease) return;
    console.warn(
      `[brevi] lease ${leaseId} for run ${lease.runId} expired: ${reason}`,
    );
    this.#settleLease(leaseId);
    const run = this.#store.get(lease.runId);
    if (!run || isTerminal(run.status)) return;
    this.#onRunInterrupted(lease.runId, reason, lease.kind);
  }

  /**
   * Tears down a lease's bookkeeping, including its LeaseStore entry. Called
   * from #completeRun on a completion, from #expireLease on an expiry, and
   * from the dispatch-rejected handler (a dispatch that never started any
   * work). A run still in flight must be settled through #expireLease, not
   * this directly, so onRunInterrupted gets a chance to run; calling this on
   * its own silently drops the run's only claim on a worker.
   */
  #settleLease(leaseId: string): void {
    const lease = this.#leases.get(leaseId);
    if (!lease) return;
    this.#leases.delete(leaseId);
    if (this.#leaseByRun.get(lease.runId) === leaseId)
      this.#leaseByRun.delete(lease.runId);
    this.#cancelIntents.delete(leaseId);
    this.#savedArtifacts.delete(leaseId);
    this.#leaseWrites.delete(leaseId);
    this.#completing.delete(leaseId);
    this.#pendingCompletions.delete(leaseId);
    this.#leaseStore.delete(leaseId);
  }

  /** A lease active for exactly this worker, or undefined; a stale or foreign leaseId must never let a message through. */
  #activeLease(workerId: string, leaseId: string): Lease | undefined {
    const lease = this.#leases.get(leaseId);
    return lease && lease.workerId === workerId ? lease : undefined;
  }

  /**
   * Resolve a lease-scoped frame's lease and guard its claimed runId against
   * the lease's actual one. Every lease-scoped frame type (dispatch-rejected,
   * run-patch, run-event, run-artifact, run-memories, run-usage-snapshot,
   * run-complete) carries
   * both a leaseId and a runId, but only the lease is trustworthy: the runId
   * is dropped, with a warning, the moment it disagrees, and lease.runId is
   * what every store mutation and scheduler callback must use from here on.
   */
  #leaseFor(
    workerId: string,
    leaseId: string,
    runId: string,
    frameType: string,
  ): Lease | undefined {
    const lease = this.#activeLease(workerId, leaseId);
    if (!lease) return undefined;
    if (lease.runId !== runId) {
      console.warn(
        `[brevi] worker ${workerId} sent a ${frameType} frame for lease ${leaseId} claiming run ${runId}, ` +
          `but that lease belongs to run ${lease.runId}; dropped`,
      );
      return undefined;
    }
    // Any lease-scoped frame that makes it this far is live contact with the
    // lease's worker, so it renews the deadline the same way a heartbeat does.
    this.#renewLease(lease);
    return lease;
  }

  #handleMessage(workerId: string, message: WorkerMessage): void {
    const worker = this.#workers.get(workerId);
    if (!worker) return; // dropped between the frame arriving and this running
    worker.lastSeenAt = new Date().toISOString();

    switch (message.type) {
      case "register":
        return; // already registered on this connection; a repeat frame is ignored, not fatal
      case "heartbeat": {
        this.#armHeartbeatWatchdog(worker);
        // Renew every lease this worker holds and tell it the applied
        // watermark for each, the same as on register, so a long-running
        // lease's replay buffer keeps getting trimmed instead of only being
        // told once at connect time. Done before the ack's own async path so
        // a slow fleet-state write never delays the renewal.
        for (const lease of this.#leasesForWorker(workerId)) {
          this.#renewLease(lease);
          this.#sendLeaseAck(worker.socket, lease);
        }
        // The ack and the store write are both async now (the fleet record's
        // lastSeenAt has to land on disk), so a failing write can't be left
        // to become an unhandled rejection that takes the host down.
        const heartbeat = this.#handleHeartbeat(worker, message.leaseIds).catch(
          (error: unknown) => {
            console.error(
              `[brevi] worker ${worker.name} (${worker.id}) heartbeat write failed: ` +
                `${error instanceof Error ? error.message : String(error)}`,
            );
          },
        );
        this.#track(heartbeat);
        return;
      }
      case "dispatch-accepted":
        return; // acknowledgement only; the lease already exists from dispatch()
      case "dispatch-rejected": {
        const lease = this.#leaseFor(
          workerId,
          message.leaseId,
          message.runId,
          "dispatch-rejected",
        );
        if (!lease) return;
        this.#settleLease(lease.id);
        this.#onRunRejected(lease.runId, message.reason, lease.kind);
        return;
      }
      case "run-patch": {
        const lease = this.#leaseFor(
          workerId,
          message.leaseId,
          message.runId,
          "run-patch",
        );
        if (!lease || !this.#admitFrame(lease, message.seq)) return;
        this.#applyReported(lease, message.seq, () =>
          this.#applyRunPatch(lease, message.patch),
        );
        return;
      }
      case "run-event": {
        const lease = this.#leaseFor(
          workerId,
          message.leaseId,
          message.runId,
          "run-event",
        );
        if (!lease || !this.#admitFrame(lease, message.seq)) return;
        // The host is the sole owner of "artifact" events: it appends one
        // itself (via RunStore.addArtifact) once an artifact's bytes are
        // actually saved. A worker sending one here would double-log it; an
        // older worker that still sends them must be ignored, not obeyed.
        // Nothing to apply, but the watermark still has to move past it or
        // the worker would replay this frame forever. It goes on the chain
        // like any other, with no write of its own, so it cannot overtake a
        // frame ahead of it that is still being written.
        if (message.event.type === "artifact") {
          this.#applyReported(lease, message.seq, () => Promise.resolve());
          return;
        }
        // On the chain like every other reported frame, rather than appended
        // inline: it keeps a log line in wire order behind the patch ahead of
        // it, and it is what lets the watermark wait for the append to reach
        // disk (appendEvent queues its write, see RunStore).
        this.#applyReported(lease, message.seq, async () => {
          this.#store.appendEvent({ ...message.event, runId: lease.runId });
          await this.#store.flush();
        });
        return;
      }
      case "run-artifact": {
        const lease = this.#leaseFor(
          workerId,
          message.leaseId,
          message.runId,
          "run-artifact",
        );
        if (!lease || !this.#admitFrame(lease, message.seq)) return;
        this.#applyReported(lease, message.seq, () =>
          this.#saveArtifact(lease, message),
        );
        return;
      }
      case "run-memories": {
        const lease = this.#leaseFor(
          workerId,
          message.leaseId,
          message.runId,
          "run-memories",
        );
        if (!lease || !this.#admitFrame(lease, message.seq)) return;
        this.#applyReported(lease, message.seq, () =>
          this.#recordMemories(lease.runId, message),
        );
        return;
      }
      case "run-usage-snapshot": {
        // An attach re-export arrives without a lease: the run's lease was
        // released long before the terminal exited. It is validated the same
        // way, applied directly (no sequence admission), and stays safe
        // because a snapshot replaces its session's archive file wholesale.
        // With no lease to vouch for the run binding, the run's recorded
        // executor stands in: only the worker that ran it may re-export its
        // usage, so no enrolled machine can rewrite another run's accounting.
        if (message.leaseId === undefined) {
          const run = this.#store.get(message.runId);
          if (!run || run.sandbox.workerId !== workerId) return;
          this.#track(
            this.#saveUsageSnapshot(message.runId, message).catch(
              (error: unknown) => {
                console.error(
                  `[brevi] usage snapshot for run ${message.runId} failed to archive: ` +
                    `${error instanceof Error ? error.message : String(error)}`,
                );
              },
            ),
          );
          return;
        }
        const lease = this.#leaseFor(
          workerId,
          message.leaseId,
          message.runId,
          "run-usage-snapshot",
        );
        if (!lease || !this.#admitFrame(lease, message.seq)) return;
        this.#applyReported(lease, message.seq, () =>
          this.#saveUsageSnapshot(lease.runId, message),
        );
        return;
      }
      case "run-complete": {
        const lease = this.#leaseFor(
          workerId,
          message.leaseId,
          message.runId,
          "run-complete",
        );
        if (!lease || !this.#admitFrame(lease, message.seq)) return;
        if (this.#completing.has(lease.id)) return; // a replay of one already being applied
        this.#completing.add(lease.id);
        this.#track(
          this.#completeRun(workerId, lease, message).catch(
            (error: unknown) => {
              // The completion did not land, so the lease is deliberately left
              // exactly as it was: unsettled, unacknowledged, and with its
              // watermark short of this frame. The worker still holds the
              // completion in its replay buffer and resends it, which is the
              // retry. Clearing #completing and the in-flight seq is what lets
              // that resend back through #admitFrame.
              this.#completing.delete(lease.id);
              if (message.seq !== undefined)
                lease.inFlightSeqs.delete(message.seq);
              console.error(
                `[brevi] lease ${lease.id} completion for run ${lease.runId} failed to apply: ` +
                  `${error instanceof Error ? error.message : String(error)}`,
              );
            },
          ),
        );
        return;
      }
      case "lease-gap": {
        const lease = this.#leaseFor(
          workerId,
          message.leaseId,
          message.runId,
          "lease-gap",
        );
        if (!lease) return;
        this.#skipLeaseGap(lease, message.throughSeq, message.dropped);
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
      case "usage-report-result": {
        const pending = this.#usageRequests.get(message.requestId);
        if (!pending || pending.workerId !== workerId) return;
        this.#usageRequests.delete(message.requestId);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.days);
        return;
      }
    }
  }

  #handleAttachFrame(
    workerId: string,
    message: AttachDataMessage | AttachExitMessage | AttachErrorMessage,
  ): void {
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
      out.sandbox = mergeSandbox(
        run?.sandbox ?? {},
        patch.sandbox,
        lease.workerId,
      );
    }
    await this.#store.update(lease.runId, out);
  }

  async #saveArtifact(
    lease: Lease,
    message: RunArtifactMessage,
  ): Promise<void> {
    if (!isSafePathSegment(message.artifact.name)) {
      console.warn(
        `[brevi] worker sent an unsafe artifact name for run ${lease.runId}; dropped`,
      );
      return;
    }
    const dir = this.#store.artifactsDir(lease.runId);
    const path = resolveWithin(dir, message.artifact.name);
    if (!path) {
      console.warn(
        `[brevi] worker sent an artifact name that escapes the artifacts directory for run ${lease.runId}; dropped`,
      );
      return;
    }
    const decoded = Buffer.from(message.data, "base64");
    if (decoded.length > WORKER_MAX_ARTIFACT_BYTES) {
      console.warn(
        `[brevi] worker sent an oversized artifact (${decoded.length} bytes) for run ${lease.runId}; dropped`,
      );
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

  /**
   * Validate and archive one usage snapshot. Validation failures are dropped
   * with a warning rather than thrown, same policy as #saveArtifact: a
   * resend cannot fix them, and the lease's watermark has to advance past
   * the frame. A genuine filesystem failure still throws, so the frame stays
   * unapplied and the worker's resend retries it.
   */
  async #saveUsageSnapshot(
    runId: string,
    message: RunUsageSnapshotMessage,
  ): Promise<void> {
    const bytes = Buffer.byteLength(message.jsonl, "utf8");
    if (bytes > WORKER_MAX_USAGE_SNAPSHOT_BYTES) {
      console.warn(
        `[brevi] worker sent an oversized usage snapshot (${bytes} bytes) for run ${runId}; dropped`,
      );
      return;
    }
    if (
      message.contentHash !== undefined &&
      createHash("sha256").update(message.jsonl).digest("hex") !== message.contentHash
    ) {
      console.warn(
        `[brevi] usage snapshot for run ${runId} does not match its content hash; dropped`,
      );
      return;
    }
    if (!this.#usage.pathFor(message.source, message.projectKey, message.sessionId, message.subagentId)) {
      console.warn(
        `[brevi] worker sent an unsafe usage snapshot path for run ${runId}; dropped`,
      );
      return;
    }
    await this.#usage.save(
      message.source,
      message.projectKey,
      message.sessionId,
      message.jsonl,
      message.subagentId,
    );
  }

  async #recordMemories(
    runId: string,
    message: RunMemoriesMessage,
  ): Promise<void> {
    const { added, reaffirmed } = await this.#memories.record(
      message.repo,
      message.learned,
      {
        maxEntries: this.#config.memory.maxEntries,
        ident: message.ident,
      },
    );
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
   *
   * A completion is refused, not just deferred, while anything below it is
   * still missing. Its ack is the strongest one in the protocol: it tells the
   * worker to throw away the lease's entire replay buffer, which is the only
   * copy of whatever did not land. So a gap parks the whole completion in
   * #pendingCompletions and nothing is written, acked or settled until the
   * resend machinery closes it (see #maybeFinishPendingCompletion), leaving
   * the run honestly unfinished in the meantime.
   */
  async #completeRun(
    workerId: string,
    lease: Lease,
    message: RunCompleteMessage,
  ): Promise<void> {
    // Everything this lease sent ahead of the completion has to have landed
    // before the manifest is reconciled against what was saved, and before
    // settleLease drops the lease's bookkeeping underneath a late write.
    await this.#drainLeaseWrites(lease.id);
    if (!this.#contiguousBelow(lease, message.seq)) {
      console.warn(
        `[brevi] holding run ${lease.runId}'s completion: applied through ${lease.appliedSeq} but it is frame ${message.seq ?? 0}, ` +
          `so something between them has not landed yet`,
      );
      this.#pendingCompletions.set(lease.id, { workerId, message });
      return;
    }
    await this.#finishCompletion(workerId, lease, message);
  }

  /** Whether every frame below `seq` has been applied, so a completion at `seq` is safe to acknowledge. */
  #contiguousBelow(lease: Lease, seq: number | undefined): boolean {
    if (seq === undefined) return true; // a worker that predates sequencing has no gaps to speak of
    return lease.appliedSeq >= seq - 1;
  }

  /** The tail of #completeRun, split out so a completion held behind a gap can be finished later from #markApplied. */
  async #finishCompletion(
    workerId: string,
    lease: Lease,
    message: RunCompleteMessage,
  ): Promise<void> {
    await this.#applyRunComplete(lease, message);
    // Applied, so the watermark may move: a lease-ack racing this on another
    // frame must never report less than what is now on disk. Settling drops
    // the lease's store entry right after, which is the stronger form of the
    // same acknowledgement.
    this.#markApplied(lease, message.seq);
    this.#reconcileArtifacts(lease, message.artifacts);
    const live = this.#workers.get(workerId);
    if (live)
      this.#send(live.socket, {
        type: "run-complete-ack",
        leaseId: lease.id,
        runId: lease.runId,
      });
    this.#settleLease(lease.id);
    this.#onRunSettled(lease.runId);
  }

  /**
   * A gap just closed, so a completion parked behind it may now be safe to
   * apply. Called from #markApplied, which is the only place the contiguous
   * watermark ever moves.
   */
  #maybeFinishPendingCompletion(lease: Lease): void {
    const pending = this.#pendingCompletions.get(lease.id);
    if (!pending || !this.#contiguousBelow(lease, pending.message.seq)) return;
    this.#pendingCompletions.delete(lease.id);
    console.log(
      `[brevi] run ${lease.runId}'s completion is unblocked; the missing frames arrived`,
    );
    this.#track(
      this.#finishCompletion(pending.workerId, lease, pending.message).catch(
        (error: unknown) => {
          this.#completing.delete(lease.id);
          if (pending.message.seq !== undefined)
            lease.inFlightSeqs.delete(pending.message.seq);
          console.error(
            `[brevi] lease ${lease.id} completion for run ${lease.runId} failed to apply: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        },
      ),
    );
  }

  /**
   * Append one lease-scoped write to that lease's chain. A failing write is
   * logged and swallowed so it cannot break the chain for the frames behind
   * it: losing one artifact must not strand the completion that follows.
   */
  #chainLeaseWrite(leaseId: string, write: () => Promise<void>): Promise<void> {
    const next: Promise<void> = (
      this.#leaseWrites.get(leaseId) ?? Promise.resolve()
    )
      .then(write)
      .catch((error: unknown) => {
        console.error(
          `[brevi] lease ${leaseId} write failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        // Drop the chain once it has drained, so the map never accumulates
        // settled promises and a completion with nothing outstanding ahead of
        // it does not defer itself a tick waiting on one.
        if (this.#leaseWrites.get(leaseId) === next)
          this.#leaseWrites.delete(leaseId);
      });
    this.#leaseWrites.set(leaseId, next);
    return next;
  }

  async #applyRunComplete(
    lease: Lease,
    message: RunCompleteMessage,
  ): Promise<void> {
    const run = this.#store.get(lease.runId);
    const sandbox = mergeSandbox(
      run?.sandbox ?? {},
      message.sandbox,
      lease.workerId,
    );
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
