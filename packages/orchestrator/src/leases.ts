import { readFile } from "node:fs/promises";
import { atomicWriteJson, LEASES_PATH, WriteQueue } from "@brevi/shared";

/**
 * Persists WorkerRegistry's outstanding leases to LEASES_PATH so a host
 * restart can pick its in-flight runs back up (see WorkerRegistry.restore).
 * Follows state.ts's conventions: an in-memory Map is the read model, every
 * disk write is serialized through one promise chain, and a read failure
 * (missing or corrupt file) never throws, it just leaves the store empty.
 *
 * Write policy: `delete` and a `put` of a lease the store did not have yet
 * write immediately, since creating or releasing a lease is rare and must
 * survive a crash. A `put` that only advances `appliedSeq` or `expiresAt` on
 * a lease the store already has is coalesced behind a short debounce
 * (LEASE_WRITE_DEBOUNCE_MS), because the watermark advances on every log
 * line a run streams and writing on every one would thrash the disk. The
 * cost is bounded and worth stating plainly: a hard crash can lose up to a
 * second of watermark, which makes a reconnecting worker replay a few
 * frames the host already applied. Duplicated console lines are the worst
 * that can come of that.
 */
export interface PersistedLease {
  id: string;
  runId: string;
  workerId: string;
  /** Last known display name of the owning worker, for log lines before it reconnects. */
  workerName: string;
  kind: "implementation" | "follow-up";
  issuedAt: string;
  /** When the host stops expecting this lease's worker to report. */
  expiresAt: string;
  /** Highest reporting sequence number applied for this lease; the replay watermark a reconnecting worker is told. */
  appliedSeq: number;
}

/** How long a `put()` that only advances an already-known lease's watermark is held before it reaches disk. */
const LEASE_WRITE_DEBOUNCE_MS = 1_000;

function isPersistedLease(value: unknown): value is PersistedLease {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.runId === "string" &&
    typeof v.workerId === "string" &&
    typeof v.workerName === "string" &&
    (v.kind === "implementation" || v.kind === "follow-up") &&
    typeof v.issuedAt === "string" &&
    typeof v.expiresAt === "string" &&
    typeof v.appliedSeq === "number"
  );
}

export class LeaseStore {
  readonly #path: string;
  #leases = new Map<string, PersistedLease>();
  /** Every write, immediate or debounced, serializes through here (see WriteQueue). */
  #io = new WriteQueue("lease store");
  #debounceTimer?: NodeJS.Timeout;

  constructor(path: string = LEASES_PATH) {
    this.#path = path;
  }

  /** Load the file (missing or corrupt is treated as empty, never thrown), and return what it loaded. */
  async init(): Promise<PersistedLease[]> {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const leases: PersistedLease[] = [];
    for (const entry of parsed) {
      if (!isPersistedLease(entry)) continue;
      leases.push(entry);
      this.#leases.set(entry.id, entry);
    }
    return leases;
  }

  list(): PersistedLease[] {
    return [...this.#leases.values()];
  }

  /** Upsert a lease. See the class doc comment for when this writes immediately versus debounced. */
  put(lease: PersistedLease): void {
    const isNewLease = !this.#leases.has(lease.id);
    this.#leases.set(lease.id, lease);
    if (isNewLease) this.#writeNow();
    else this.#writeDebounced();
  }

  /**
   * Upsert a lease and resolve only once it is actually on disk, rejecting if
   * the write failed. `put` is fire-and-forget, which is right for a
   * watermark but not for the claim itself: a lease has to be durable before
   * anyone is told the run was dispatched, or a crash in that window leaves
   * the next boot with no record of a run a worker is already executing.
   */
  async putDurable(lease: PersistedLease): Promise<void> {
    this.#leases.set(lease.id, lease);
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = undefined;
    }
    await this.#io.enqueue(() => this.#persist(this.list()));
  }

  delete(id: string): void {
    if (!this.#leases.delete(id)) return;
    this.#writeNow();
  }

  /** Wait for every pending write, including one still sitting behind the debounce, to land on disk. */
  async flush(): Promise<void> {
    if (this.#debounceTimer) this.#writeNow();
    await this.#io.flush();
  }

  #writeDebounced(): void {
    if (this.#debounceTimer) return; // a write is already scheduled; it will pick up this update too
    const timer = setTimeout(() => this.#writeNow(), LEASE_WRITE_DEBOUNCE_MS);
    timer.unref();
    this.#debounceTimer = timer;
  }

  #writeNow(): void {
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = undefined;
    }
    void this.#io.enqueue(() => this.#persist(this.list())).catch(() => undefined);
  }

  /**
   * Atomic (see atomicWriteJson) because a corrupt leases.json is treated as
   * "no leases", losing every in-flight run's claim on restart rather than
   * just the last debounce window.
   */
  #persist(leases: PersistedLease[]): Promise<void> {
    return atomicWriteJson(this.#path, leases);
  }
}
