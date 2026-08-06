import { EventEmitter } from "node:events";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  RUNS_DIR,
  summarizeCosts,
  type ArtifactRef,
  type CostEntry,
  type Run,
  type RunAttempt,
  type RunEvent,
  type RunStatus,
  type SandboxProviderName,
  type Ticket,
} from "@brevi/shared";

/** Statuses for runs with an agent execution in flight (or about to start). */
export const ACTIVE_STATUSES: ReadonlySet<RunStatus> = new Set([
  "queued",
  "preparing",
  "running",
  "finalizing",
]);

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(["completed", "failed", "cancelled"]);

/** Terminal = no further work will happen without a manual retry. "waiting" is neither active nor terminal. */
export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Short, sortable run id: time prefix + random suffix, e.g. "20260804-153012-k3f9". */
function newRunId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
    .replace("T", "-");
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  return `${stamp}-${rand}`;
}

interface RunStoreEvents {
  "run-updated": [Run];
  "run-event": [RunEvent];
}

/**
 * Owns all Run state. Every run lives at RUNS_DIR/<id>/ as run.json (current
 * snapshot), events.jsonl (append-only activity log), and artifacts/.
 */
export class RunStore extends EventEmitter<RunStoreEvents> {
  readonly runsDir: string;
  #runs = new Map<string, Run>();
  /** Serializes all disk writes so snapshots and event lines never interleave. */
  #io: Promise<void> = Promise.resolve();

  constructor(runsDir: string = RUNS_DIR) {
    super();
    this.runsDir = runsDir;
  }

  /**
   * Load persisted runs; mark runs interrupted by a previous process as
   * failed. Runs waiting on a usage-limit reset survive restarts; the
   * orchestrator reschedules their resume on boot.
   */
  async init(): Promise<void> {
    await mkdir(this.runsDir, { recursive: true });
    const entries = await readdir(this.runsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      let run: Run;
      try {
        const raw = await readFile(join(this.runsDir, entry.name, "run.json"), "utf8");
        run = JSON.parse(raw) as Run;
      } catch {
        continue; // unreadable run dir; skip rather than crash
      }
      // Runs persisted before attempts existed.
      if (!Array.isArray(run.attempts)) run = { ...run, attempts: [] };
      // Runs persisted before costs existed.
      if (!Array.isArray(run.costs)) run = { ...run, costs: [] };
      if (!isTerminal(run.status) && run.status !== "waiting") {
        run = {
          ...run,
          status: "failed",
          error: "orchestrator restarted",
          finishedAt: new Date().toISOString(),
        };
        await this.#persist(run);
      }
      this.#runs.set(run.id, run);
    }
  }

  async createRun(ticket: Ticket, provider: SandboxProviderName): Promise<Run> {
    const run: Run = {
      id: newRunId(),
      ticket,
      status: "queued",
      sandbox: { provider },
      createdAt: new Date().toISOString(),
      attempts: [],
      costs: [],
    };
    await mkdir(this.artifactsDir(run.id), { recursive: true });
    await this.#persist(run);
    this.#runs.set(run.id, run);
    this.emit("run-updated", run);
    this.appendEvent({ runId: run.id, ts: run.createdAt, type: "status", status: "queued" });
    return run;
  }

  get(id: string): Run | undefined {
    return this.#runs.get(id);
  }

  /** All runs, newest first (ids are time-prefixed, so lexical order is time order). */
  list(): Run[] {
    return [...this.#runs.values()].sort((a, b) => b.id.localeCompare(a.id));
  }

  runsForTicket(ticketId: string): Run[] {
    return this.list().filter((run) => run.ticket.id === ticketId);
  }

  async update(id: string, patch: Partial<Omit<Run, "id">>): Promise<Run> {
    const existing = this.#runs.get(id);
    if (!existing) throw new Error(`unknown run ${id}`);
    const run: Run = { ...existing, ...patch };
    this.#runs.set(id, run);
    await this.#persist(run);
    this.emit("run-updated", run);
    return run;
  }

  /** Transition status, persist, and emit both the run update and a status event. */
  async setStatus(id: string, status: RunStatus, patch: Partial<Omit<Run, "id">> = {}): Promise<Run> {
    const run = await this.update(id, { ...patch, status });
    this.appendEvent({ runId: id, ts: new Date().toISOString(), type: "status", status });
    return run;
  }

  /** Open a new attempt on the run and mark its start in the event log. */
  async beginAttempt(runId: string): Promise<RunAttempt> {
    const run = this.#runs.get(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    const attempt: RunAttempt = { number: run.attempts.length + 1, startedAt: new Date().toISOString() };
    await this.update(runId, { attempts: [...run.attempts, attempt] });
    this.appendEvent({ runId, ts: attempt.startedAt, type: "attempt", number: attempt.number });
    return attempt;
  }

  /** Close the run's latest attempt with its outcome. */
  async endAttempt(runId: string, patch: Partial<Omit<RunAttempt, "number" | "startedAt">>): Promise<void> {
    const run = this.#runs.get(runId);
    const last = run?.attempts.at(-1);
    if (!run || !last || last.finishedAt) return;
    const closed: RunAttempt = { ...last, finishedAt: new Date().toISOString(), ...patch };
    await this.update(runId, { attempts: [...run.attempts.slice(0, -1), closed] });
  }

  /** Append an event to the run's log. Emits synchronously; disk write is queued. */
  appendEvent(event: RunEvent): void {
    const line = `${JSON.stringify(event)}\n`;
    const file = join(this.runsDir, event.runId, "events.jsonl");
    this.#enqueue(async () => {
      await mkdir(join(this.runsDir, event.runId), { recursive: true });
      await appendFile(file, line);
    });
    this.emit("run-event", event);
  }

  async addArtifact(runId: string, artifact: ArtifactRef): Promise<void> {
    const run = this.#runs.get(runId);
    if (run?.result) {
      await this.update(runId, {
        result: { ...run.result, artifacts: [...run.result.artifacts, artifact] },
      });
    }
    this.appendEvent({ runId, ts: new Date().toISOString(), type: "artifact", artifact });
  }

  /** Append a cost entry, recompute the run's totals, and log the event. */
  async addCost(runId: string, entry: CostEntry): Promise<void> {
    const run = this.#runs.get(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    const costs = [...run.costs, entry];
    await this.update(runId, { costs, costTotals: summarizeCosts(costs) });
    this.appendEvent({ runId, ts: new Date().toISOString(), type: "cost", entry });
  }

  async readEvents(runId: string): Promise<RunEvent[]> {
    await this.flush();
    let raw: string;
    try {
      raw = await readFile(join(this.runsDir, runId, "events.jsonl"), "utf8");
    } catch {
      return [];
    }
    const events: RunEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as RunEvent);
      } catch {
        // skip corrupt lines
      }
    }
    return events;
  }

  artifactsDir(runId: string): string {
    return join(this.runsDir, runId, "artifacts");
  }

  /** Wait for all queued disk writes to land. */
  async flush(): Promise<void> {
    await this.#io;
  }

  #persist(run: Run): Promise<void> {
    const dir = join(this.runsDir, run.id);
    const body = `${JSON.stringify(run, null, 2)}\n`;
    return this.#enqueue(async () => {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "run.json"), body);
    });
  }

  #enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.#io.then(task, task);
    // Keep the chain alive even when a write fails; surface it on stderr.
    this.#io = next.catch((error: unknown) => {
      console.error(`[brevi] run store write failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return next;
  }
}
