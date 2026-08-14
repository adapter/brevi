import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  FLEET_PATH,
  PAIRING_TOKEN_TTL_MINUTES,
  isPlainObject,
  workerCapabilitiesSchema,
  type WorkerCapabilities,
  type WorkerState,
} from "@brevi/shared";

/**
 * Enrollment: how a machine becomes one of this host's workers, and what
 * survives a restart of either side. Only the durable half lives here; the
 * live channel those workers speak once enrolled (WORKER_WS_PATH, dispatch,
 * leases, heartbeats) is workers.ts, which calls into this store to decide
 * whether a connecting worker is allowed in at all.
 *
 * Two secrets, two lifetimes: a pairing token is single-use and lives only in
 * memory (a host restart dropping an unredeemed one is fine, since nothing
 * durable depended on it yet); the per-worker credential it mints is what
 * actually has to survive restarts, so only its hash is ever written to disk,
 * and the enrolled fleet itself is durable state, not a cache.
 */

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Longest a worker name may be; anything past this is the operator pasting the wrong thing. */
const MAX_WORKER_NAME_CHARS = 60;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Clean up a worker name from an untrusted source, either a worker's
 * self-reported name at registration or an operator's rename request: trim,
 * strip control characters, and cap the length. "" means nothing usable was
 * left, which callers treat as "no name supplied" rather than as an error.
 */
export function sanitizeWorkerName(raw: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  return raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_WORKER_NAME_CHARS);
}

/**
 * One enrolled worker as persisted to ~/.brevi/fleet.json. Never a plaintext
 * credential, only its digest: `authenticate` is the only place the digest
 * is compared against, and it never leaves this file or that comparison.
 */
export interface WorkerRecord {
  id: string;
  name: string;
  /** sha256(credential), hex. */
  secretHash: string;
  state: WorkerState;
  enrolledAt: string;
  lastSeenAt?: string;
  capabilities?: WorkerCapabilities;
  /**
   * True for the host's own supervised worker (see ensureLocalWorker). At
   * most one record carries this; unlike every other worker's, its credential
   * is minted fresh on each boot rather than surviving one.
   */
  local?: boolean;
}

interface FleetFile {
  version: 1;
  workers: WorkerRecord[];
}

/** In-memory-only record of an unredeemed pairing token; never written to disk. */
interface PairingEntry {
  expiresAt: number;
}

/** Coerce one record read off disk into a usable worker, or null when it is not one. */
function reviveWorker(raw: unknown): WorkerRecord | null {
  if (!isPlainObject(raw)) return null;
  const { id, name, secretHash, state, enrolledAt } = raw;
  if (typeof id !== "string" || !id) return null;
  if (typeof name !== "string" || !name) return null;
  if (typeof secretHash !== "string" || !secretHash) return null;
  if (state !== "active" && state !== "draining") return null;
  if (typeof enrolledAt !== "string" || !enrolledAt) return null;
  const record: WorkerRecord = { id, name, secretHash, state, enrolledAt };
  if (typeof raw.lastSeenAt === "string") record.lastSeenAt = raw.lastSeenAt;
  if (raw.local === true) record.local = true;
  // Capabilities are validated against the same schema the register frame
  // goes through, not a hand-written copy: what was written here came off
  // that wire, so a stale file whose shape the protocol has since moved on
  // from is dropped rather than trusted.
  if (raw.capabilities !== undefined) {
    const parsed = workerCapabilitiesSchema.safeParse(raw.capabilities);
    if (parsed.success) record.capabilities = parsed.data;
  }
  return record;
}

/**
 * Persists the enrolled fleet under ~/.brevi/fleet.json. Storage mirrors
 * MemoryStore and RunStore: an in-memory Map as the read model, disk writes
 * serialized through one promise chain, and an atomic write (temp file +
 * rename) so a crash mid-write never leaves a truncated file. Unlike
 * memories, a failed write here is surfaced to the caller rather than
 * swallowed: a credential minted by redeemPairing that never reached disk
 * would authenticate for the rest of this process's life and then silently
 * stop working on the next restart, which is worse than the caller finding
 * out immediately.
 */
export class FleetStore {
  #path: string;
  #ttlMinutes: number;
  #workers = new Map<string, WorkerRecord>();
  /** Unredeemed pairing tokens, keyed by sha256(token): the token itself is never kept. */
  #pairingTokens = new Map<string, PairingEntry>();
  /** Serializes all disk writes so two redemptions finishing together cannot interleave. */
  #io: Promise<void> = Promise.resolve();

  constructor(path: string = FLEET_PATH, ttlMinutes: number = PAIRING_TOKEN_TTL_MINUTES) {
    this.#path = path;
    this.#ttlMinutes = ttlMinutes;
  }

  /**
   * Load what is on disk. A missing file just means no worker has ever
   * enrolled and is not worth a warning; anything else unreadable (bad JSON,
   * wrong shape, a hand edit gone wrong) starts empty and logs, the same
   * tolerance memory.ts uses, because a corrupt fleet file must not stop
   * brevi booting.
   */
  async init(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        console.error(`[brevi] fleet state unavailable at ${this.#path}: ${message(error)}`);
      }
      return;
    }
    try {
      const parsed = JSON.parse(raw) as FleetFile;
      if (!Array.isArray(parsed?.workers)) throw new Error("missing workers array");
      for (const entry of parsed.workers) {
        const record = reviveWorker(entry);
        if (record) this.#workers.set(record.id, record);
      }
    } catch (error) {
      console.error(`[brevi] fleet state at ${this.#path} is corrupt, starting empty: ${message(error)}`);
    }
  }

  /**
   * Mint a single-use pairing token. Only sha256(token) plus its expiry is
   * kept: like a worker credential, the token itself is not something we
   * need to remember, only recognize when it comes back.
   */
  mintPairingToken(): { token: string; expiresAt: string } {
    this.#sweepPairingTokens();
    const token = `bwp_${randomBytes(24).toString("base64url")}`;
    const expiresAt = Date.now() + this.#ttlMinutes * 60_000;
    this.#pairingTokens.set(sha256Hex(token), { expiresAt });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  /**
   * Redeem a pairing token for a durable worker credential. Single-use: the
   * entry is deleted the instant it is looked up, whether it turns out valid,
   * expired, or unknown, so retrying with the same token can never succeed
   * twice and a slow double-submit can't redeem it twice either.
   */
  async redeemPairing(
    token: string,
    info: { name?: string; capabilities: WorkerCapabilities },
  ): Promise<{ worker: WorkerRecord; credential: string } | { error: "invalid-token" | "expired-token" }> {
    const key = sha256Hex(token);
    const entry = this.#pairingTokens.get(key);
    this.#pairingTokens.delete(key);
    // Sweep other stale entries now that this one is already captured above:
    // sweeping first would delete an expired token before its own expiry
    // could be reported, collapsing "expired" into "invalid".
    this.#sweepPairingTokens();
    if (!entry) return { error: "invalid-token" };
    if (entry.expiresAt <= Date.now()) return { error: "expired-token" };

    const credential = `bwc_${randomBytes(32).toString("base64url")}`;
    // Redeeming a pairing token *is* the worker's first successful connect,
    // so lastSeenAt starts populated rather than absent: otherwise a
    // dashboard open right after enrollment would read "never connected"
    // for a worker that is, at that moment, live.
    const now = new Date().toISOString();
    const worker: WorkerRecord = {
      id: `wk-${randomBytes(5).toString("hex")}`,
      name: this.#nameFor(info.name),
      secretHash: sha256Hex(credential),
      state: "active",
      enrolledAt: now,
      lastSeenAt: now,
      capabilities: info.capabilities,
    };
    this.#workers.set(worker.id, worker);
    try {
      await this.#persist();
    } catch (error) {
      // Transactional, the same way revoke is, in the other direction: the
      // caller denies the registration when this throws, so the credential is
      // never delivered, and the token that bought it is already spent. A
      // record left behind would be an enrollment nobody can ever
      // authenticate as, kept alive in memory until some later successful
      // write made it permanent.
      this.#workers.delete(worker.id);
      throw error;
    }
    return { worker, credential };
  }

  /**
   * Authenticate a worker's durable credential. Compared as equal-length
   * sha256 digests with timingSafeEqual, not a password hash: the secret is
   * 256 bits of CSPRNG output that we handed out, never something a human
   * chose or that appears in a dictionary, so there is nothing to stretch
   * and nothing worth defending against offline guessing. What matters is
   * that comparing it doesn't leak timing information, which a plain `===`
   * would.
   */
  authenticate(workerId: string, secret: string): WorkerRecord | null {
    const worker = this.#workers.get(workerId);
    if (!worker) return null;
    const expected = Buffer.from(worker.secretHash, "hex");
    const actual = Buffer.from(sha256Hex(secret), "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    return worker;
  }

  /**
   * Mint or refresh the host's own local worker, no pairing ceremony (see
   * WorkerView.local). The first call creates the record; every later call
   * reuses its id and mints a fresh credential, held only by the child the
   * host is about to spawn and dead with this process. `state` is left
   * alone, so a drained local worker stays drained across restarts.
   */
  async ensureLocalWorker(name: string): Promise<{ workerId: string; credential: string }> {
    const credential = `bwc_${randomBytes(32).toString("base64url")}`;
    const secretHash = sha256Hex(credential);
    const existing = this.#localWorker();
    if (existing) {
      const prevSecretHash = existing.secretHash;
      const prevName = existing.name;
      existing.secretHash = secretHash;
      const clean = sanitizeWorkerName(name);
      if (clean) existing.name = clean;
      try {
        await this.#persist();
      } catch (error) {
        existing.secretHash = prevSecretHash;
        existing.name = prevName;
        throw error;
      }
      return { workerId: existing.id, credential };
    }

    const worker: WorkerRecord = {
      id: `wk-${randomBytes(5).toString("hex")}`,
      name: this.#nameFor(name),
      secretHash,
      state: "active",
      enrolledAt: new Date().toISOString(),
      local: true,
    };
    this.#workers.set(worker.id, worker);
    try {
      await this.#persist();
    } catch (error) {
      // Same discipline as redeemPairing: a record only memory knows about
      // must not survive the failed write that was supposed to make it real.
      this.#workers.delete(worker.id);
      throw error;
    }
    return { workerId: worker.id, credential };
  }

  /** The at-most-one local worker record, if this host has ever spawned one. */
  #localWorker(): WorkerRecord | undefined {
    for (const worker of this.#workers.values()) {
      if (worker.local) return worker;
    }
    return undefined;
  }

  /** Rename an enrolled worker. `name` is trusted to already be sanitized and non-empty. */
  async rename(id: string, name: string): Promise<WorkerRecord | null> {
    const worker = this.#workers.get(id);
    if (!worker) return null;
    worker.name = name;
    await this.#persist();
    return worker;
  }

  async setState(id: string, state: WorkerState): Promise<WorkerRecord | null> {
    const worker = this.#workers.get(id);
    if (!worker) return null;
    worker.state = state;
    await this.#persist();
    return worker;
  }

  /**
   * Drop a worker's record and its credential hash, so the credential it
   * holds can never authenticate again. Transactional against a failed
   * write: if #persist rejects, the record goes back into the map before
   * rethrowing, so the credential stays live (and a retried revoke can still
   * find it) instead of the in-memory state disagreeing with what's on disk
   * until the next restart quietly un-revokes it.
   */
  async revoke(id: string): Promise<boolean> {
    const record = this.#workers.get(id);
    if (!record) return false;
    this.#workers.delete(id);
    try {
      await this.#persist();
    } catch (error) {
      this.#workers.set(id, record);
      throw error;
    }
    return true;
  }

  /** Refresh liveness/capabilities from a register or heartbeat. */
  async touch(id: string, patch: { lastSeenAt?: string; capabilities?: WorkerCapabilities }): Promise<WorkerRecord | null> {
    const worker = this.#workers.get(id);
    if (!worker) return null;
    if (patch.lastSeenAt !== undefined) worker.lastSeenAt = patch.lastSeenAt;
    if (patch.capabilities !== undefined) worker.capabilities = patch.capabilities;
    await this.#persist();
    return worker;
  }

  get(id: string): WorkerRecord | undefined {
    return this.#workers.get(id);
  }

  /**
   * Every enrolled worker, oldest enrollment first. Sorted explicitly by
   * enrolledAt rather than relying on the backing Map's insertion order: a
   * record restored after a failed revoke (see revoke) re-inserts at the end
   * of the map, which would otherwise put it out of place. Ties (same
   * millisecond) break on id for a stable, deterministic order.
   */
  list(): WorkerRecord[] {
    return [...this.#workers.values()].sort((a, b) => {
      if (a.enrolledAt !== b.enrolledAt) return a.enrolledAt < b.enrolledAt ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  /** Sweep expired pairing tokens; called on every mint/redeem so the map never grows unbounded. */
  #sweepPairingTokens(): void {
    const now = Date.now();
    for (const [key, entry] of this.#pairingTokens) {
      if (entry.expiresAt <= now) this.#pairingTokens.delete(key);
    }
  }

  /**
   * Resolve the name a newly enrolled worker gets: the requested name,
   * sanitized, if it is both present and not already taken; otherwise a
   * generated `worker-<n>` (or a disambiguated `name (2)`) so two machines
   * paired with the same requested name don't collide.
   */
  #nameFor(requested: string | undefined): string {
    const clean = sanitizeWorkerName(requested ?? "");
    if (clean && !this.#nameTaken(clean)) return clean;
    if (clean) {
      let n = 2;
      while (this.#nameTaken(`${clean} (${n})`)) n += 1;
      return `${clean} (${n})`;
    }
    let n = this.#workers.size + 1;
    while (this.#nameTaken(`worker-${n}`)) n += 1;
    return `worker-${n}`;
  }

  #nameTaken(name: string): boolean {
    for (const worker of this.#workers.values()) {
      if (worker.name === name) return true;
    }
    return false;
  }

  /**
   * Atomic write (temp file + rename), mode 0600 because the file holds
   * credential hashes: even though a hash can't be turned back into a
   * credential, there's no reason to leave it world-readable at the process
   * umask's default.
   */
  #persist(): Promise<void> {
    const body: FleetFile = { version: 1, workers: [...this.#workers.values()] };
    const text = `${JSON.stringify(body, null, 2)}\n`;
    return this.#enqueue(async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      const temp = `${this.#path}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        await writeFile(temp, text, { mode: 0o600 });
        await rename(temp, this.#path);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  /**
   * Unlike MemoryStore's equivalent, this rejects the promise it returns
   * when the write fails (see the class doc comment): callers that must know
   * a write landed, like redeemPairing, await it directly. The internal
   * chain still recovers so a later write isn't blocked by an earlier
   * failure.
   */
  #enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.#io.then(task, task);
    this.#io = next.catch((error: unknown) => {
      console.error(`[brevi] fleet store write failed: ${message(error)}`);
    });
    return next;
  }
}
