import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  summarizeCosts,
  WORKER_MAX_ARTIFACT_BYTES,
  WORKSPACES_DIR,
  type ArtifactRef,
  type CostEntry,
  type Run,
  type RunAttempt,
  type RunEvent,
  type RunPatch,
  type RunStatus,
  type WorkerMessage,
} from "@brevi/shared";
import { resolveWithin } from "@brevi/orchestrator/internal";
import type { WorkerConnection } from "./connection.js";
import type { RunSink } from "./sink.js";

/** RunPatch's field set, in the order Run declares them; anything else a caller passes (id, ticket, createdAt) never travels. */
const RUN_PATCH_FIELDS = [
  "status",
  "startedAt",
  "finishedAt",
  "queuedAt",
  "error",
  "resumeAt",
  "agentSessionId",
  "limit",
  "result",
  "prUrl",
  "prState",
  "attempts",
  "costs",
  "costTotals",
  "sandbox",
] as const satisfies readonly (keyof RunPatch)[];

/** sandbox's own field set, mirroring RUN_PATCH_FIELDS one level deeper. */
const SANDBOX_PATCH_FIELDS = ["provider", "id", "retainedUntil"] as const satisfies readonly (keyof Run["sandbox"])[];

/**
 * Reduce a local `store.update`-shaped patch to the wire's RunPatch: only the
 * keys the caller actually named (an explicit `undefined` clears a field, an
 * absent key leaves it alone), with `undefined` translated to `null` since
 * JSON drops `undefined` keys outright and the protocol needs "clear this
 * field" to survive the trip. `sandbox` gets the identical treatment one
 * level deeper (see SANDBOX_PATCH_FIELDS): a caller reports it as a partial,
 * domain-shaped object (e.g. `{ retainedUntil: undefined }` to clear just
 * that), and the same "named+undefined -> null, absent -> absent" rule
 * applies to its own fields, since JSON drops an `undefined` wherever it
 * sits, nested or not.
 */
function toRunPatch(patch: Partial<Omit<Run, "id">>): RunPatch {
  const source = patch as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of RUN_PATCH_FIELDS) {
    if (!(key in source)) continue;
    const value = source[key];
    if (key === "sandbox") {
      out.sandbox = value === undefined ? null : toSandboxPatch(value as Record<string, unknown>);
      continue;
    }
    out[key] = value === undefined ? null : value;
  }
  return out as RunPatch;
}

function toSandboxPatch(sandbox: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SANDBOX_PATCH_FIELDS) {
    if (!(key in sandbox)) continue;
    const value = sandbox[key];
    out[key] = value === undefined ? null : value;
  }
  return out;
}

export interface RunReporterOptions {
  /** The run snapshot from the dispatch; kept in memory and mutated locally so get() behaves like the host's store. */
  run: Run;
  /** Correlates every message this reporter sends with the lease the dispatch granted. */
  leaseId: string;
  connection: WorkerConnection;
}

/**
 * `RunSink` implementation for a dispatched run: the subset of the host's
 * run store one run mutates, implemented by mirroring every mutation to the
 * host over the worker connection instead of writing to disk. Kept
 * semantically identical to `RunStore` (see state.ts) so `runner.ts` and
 * `followup.ts` behave exactly the same whether they're running against a
 * local store on the host or a reporter on a worker: the in-memory snapshot
 * is updated first (so `get()` always reflects it immediately), then the
 * mutation is mirrored, all before the call resolves.
 */
export class RunReporter implements RunSink {
  #run: Run;
  readonly #leaseId: string;
  readonly #connection: WorkerConnection;
  /** costs[] index of each in-flight execution's interim entry; see RunStore's twin of this. */
  readonly #interimCostIndex = new Map<string, number>();
  /** Every artifact this reporter actually shipped to the host under this lease; a skipped oversized one never lands here. See addArtifact and the manifest run-complete carries. */
  readonly #artifacts: ArtifactRef[] = [];

  constructor(options: RunReporterOptions) {
    this.#run = options.run;
    this.#leaseId = options.leaseId;
    this.#connection = options.connection;
  }

  /** The run's current snapshot as this reporter has mutated it, exactly what get() on a host RunStore would answer. */
  get run(): Run {
    return this.#run;
  }

  /** Artifacts transferred so far under this lease, for run-complete's manifest. */
  get artifacts(): ArtifactRef[] {
    return this.#artifacts;
  }

  get(runId: string): Run | undefined {
    return runId === this.#run.id ? this.#run : undefined;
  }

  async update(runId: string, patch: Partial<Omit<Run, "id">>): Promise<Run> {
    this.#run = {
      ...this.#run,
      ...patch,
      // Every other field above is a full replacement value the caller
      // already computed, but sandbox now travels as a merge (callers report
      // only what changed, e.g. just retainedUntil): re-merge it onto what
      // this reporter already has, so the in-memory snapshot (what get()
      // answers, and what run-complete is built from) stays complete instead
      // of losing provider/id to a patch that never mentioned them.
      ...("sandbox" in patch ? { sandbox: { ...this.#run.sandbox, ...patch.sandbox } } : {}),
    };
    this.#send({ type: "run-patch", leaseId: this.#leaseId, runId, patch: toRunPatch(patch) });
    return this.#run;
  }

  async setStatus(runId: string, status: RunStatus, patch: Partial<Omit<Run, "id">> = {}): Promise<Run> {
    const run = await this.update(runId, { ...patch, status });
    this.appendEvent({ runId, ts: new Date().toISOString(), type: "status", status });
    return run;
  }

  appendEvent(event: RunEvent): void {
    this.#send({ type: "run-event", leaseId: this.#leaseId, runId: event.runId, event });
  }

  async beginAttempt(runId: string, kind?: RunAttempt["kind"]): Promise<RunAttempt> {
    const attempt: RunAttempt = {
      number: this.#run.attempts.length + 1,
      startedAt: new Date().toISOString(),
      ...(kind ? { kind } : {}),
    };
    await this.update(runId, { attempts: [...this.#run.attempts, attempt] });
    this.appendEvent({ runId, ts: attempt.startedAt, type: "attempt", number: attempt.number });
    return attempt;
  }

  async endAttempt(runId: string, patch: Partial<Omit<RunAttempt, "number" | "startedAt">>): Promise<void> {
    const last = this.#run.attempts.at(-1);
    if (!last || last.finishedAt) return;
    const closed: RunAttempt = { ...last, finishedAt: new Date().toISOString(), ...patch };
    await this.update(runId, { attempts: [...this.#run.attempts.slice(0, -1), closed] });
  }

  async addCost(runId: string, entry: CostEntry, executionId?: string): Promise<void> {
    await this.#upsertCost(runId, entry, executionId);
    if (executionId !== undefined) this.#interimCostIndex.delete(executionId);
    this.appendEvent({ runId, ts: new Date().toISOString(), type: "cost", entry });
  }

  /** No "cost" event: interim samples land at sampling cadence and would bloat the log, same as RunStore's version. */
  async upsertCost(runId: string, executionId: string, entry: CostEntry): Promise<void> {
    await this.#upsertCost(runId, entry, executionId);
  }

  async #upsertCost(runId: string, entry: CostEntry, executionId?: string): Promise<void> {
    const index = executionId === undefined ? undefined : this.#interimCostIndex.get(executionId);
    let costs: CostEntry[];
    if (index !== undefined && index < this.#run.costs.length) {
      costs = this.#run.costs.map((existing, i) => (i === index ? entry : existing));
    } else {
      costs = [...this.#run.costs, entry];
      if (executionId !== undefined) this.#interimCostIndex.set(executionId, costs.length - 1);
    }
    await this.update(runId, { costs, costTotals: summarizeCosts(costs) });
  }

  /**
   * Mirrors RunStore.addArtifact's local bookkeeping (a no-op unless
   * `result` is already set, which is rare: results normally land after
   * every artifact for the run has already been added) then, unlike the
   * host's version, actually ships the bytes: the file lives only on this
   * worker's disk, so the host needs the data, not just the metadata.
   * Anything over WORKER_MAX_ARTIFACT_BYTES is skipped with a system log
   * event explaining why instead of being sent.
   */
  async addArtifact(runId: string, artifact: ArtifactRef): Promise<void> {
    if (this.#run.result) {
      this.#run = {
        ...this.#run,
        result: { ...this.#run.result, artifacts: [...this.#run.result.artifacts, artifact] },
      };
    }
    const filePath = resolveWithin(this.artifactsDir(runId), artifact.name);
    if (!filePath) return;
    let data: Buffer;
    try {
      data = await readFile(filePath);
    } catch {
      return;
    }
    if (data.byteLength > WORKER_MAX_ARTIFACT_BYTES) {
      this.appendEvent({
        runId,
        ts: new Date().toISOString(),
        type: "log",
        stream: "system",
        text: `artifact ${artifact.name} is ${data.byteLength} bytes, over the ${WORKER_MAX_ARTIFACT_BYTES}-byte transfer limit; not sent to the host`,
      });
      return;
    }
    this.#send({ type: "run-artifact", leaseId: this.#leaseId, runId, artifact, data: data.toString("base64") });
    this.#artifacts.push(artifact);
    // No explicit "artifact" run event here: the host's RunStore appends one
    // itself once it saves the transferred bytes, so emitting one here too
    // would double it up in the persisted stream.
  }

  artifactsDir(runId: string): string {
    return join(WORKSPACES_DIR, runId, "artifacts");
  }

  #send(message: WorkerMessage): void {
    this.#connection.send(message);
  }
}
