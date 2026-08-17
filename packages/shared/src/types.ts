/** Core domain types shared between the orchestrator, sandbox, CLI, and dashboard. */

export interface Ticket {
  /** Provider-scoped id (e.g. Linear issue id). */
  id: string;
  /** Human identifier, e.g. "ENG-123". */
  identifier: string;
  title: string;
  description: string;
  url: string;
  labels: string[];
  /** Ticket state name in the tracker, e.g. "Todo". */
  state: string;
  /** Repo key (from config.repos) this ticket resolves to, if known. */
  repo?: string;
  /** ISO timestamp the ticket was last updated in the tracker. */
  updatedAt: string;
}

export type RunStatus =
  | "queued"
  | "preparing"
  | "running"
  | "finalizing"
  /** Blocked on an agent usage limit; a new attempt starts once it lifts. */
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

/** Which coding agent's usage limit was hit. */
export type LimitProvider = "claude" | "codex" | "grok";

/** A usage limit reported by the coding agent during an attempt. */
export interface LimitInfo {
  provider: LimitProvider;
  /** Which limit window was exhausted, when the agent said so. */
  kind: "five-hour" | "weekly" | "unknown";
  /** ISO time the limit lifts, when the agent reported one. */
  resetsAt?: string;
  /** The agent output line that triggered detection. */
  message: string;
}

export type AttemptOutcome = "completed" | "failed" | "cancelled" | "limit";

/**
 * Lifecycle state of a run's pull request on GitHub, matching GitHub's own
 * semantics: "open" and "draft" are still in review, "merged" and "closed"
 * are final.
 */
export type PrState = "open" | "draft" | "merged" | "closed";

/**
 * One agent execution within a run. A run retried after a usage limit (or
 * manually) accumulates attempts; each attempt's output is preserved in the
 * run's event log between its "attempt" markers.
 */
export interface RunAttempt {
  /** 1-based sequence number within the run. */
  number: number;
  startedAt: string;
  /** Set on follow-up executions (rebase + address PR feedback); absent for ordinary implementation attempts. */
  kind?: "follow-up";
  finishedAt?: string;
  outcome?: AttemptOutcome;
  /** Failure detail when the outcome is "failed". */
  error?: string;
  /** The usage limit that ended this attempt, when the outcome is "limit". */
  limit?: LimitInfo;
}

/** Name of the sandbox a run executed in. Current workers always report "bwrap". */
export type SandboxProviderName = string;

export interface ArtifactRef {
  /** File name within the run's artifact directory. */
  name: string;
  type: "screenshot" | "recording" | "document" | "log" | "other";
  /** Size in bytes at capture time. */
  size: number;
}

/**
 * One model's share of an execution's usage. An execution that spans several
 * models (orchestrator loop, implementer subagent) gets one row per model;
 * the owning entry's top-level figures are the roll-up.
 */
export interface CostModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Absent when only tokens are known. */
  costUsd?: number;
}

/**
 * LLM usage and cost of one agent execution within a run. Generic over
 * providers and phases: a run is N executions (attempts today, more phases or
 * subagents later), and the run's total is the sum over its entries.
 */
export interface CostEntry {
  /** Which execution produced it, e.g. "implementation", "review fixes", "implementation (attempt 2)". */
  label: string;
  /** "claude" | "codex" | "grok" | future providers. */
  provider: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Absent when only tokens are known. */
  costUsd?: number;
  /** True when computed from a pricing table (or modeled on a subscription login) instead of reported by the provider. */
  estimated?: boolean;
  /**
   * Per-model rows behind the roll-up figures above, present when the
   * execution spanned several models (e.g. a delegated Claude run), whether
   * measured from the agent's transcripts (ccusage) or reconstructed from
   * the output stream. Single-model executions stay flat.
   */
  breakdown?: CostModelUsage[];
}

/**
 * One model's aggregated share of a run's cost: tokens and cost summed across
 * every entry (attempt, phase, provider) that used the model.
 */
export interface CostModelTotal {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Absent when only tokens are known for this model. */
  costUsd?: number;
  /** True when any contributing figure is estimated rather than provider-reported. */
  estimated: boolean;
}

/** Derived sums over a run's cost entries. */
export interface CostTotals {
  /** Sum of entry costUsd values; absent when no entry carries a cost. */
  costUsd?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** True when any contributing entry is estimated rather than provider-reported. */
  estimated: boolean;
  /** Per-model roll-up across every entry, highest cost first. Absent from totals persisted by older orchestrators. */
  byModel?: CostModelTotal[];
}

/**
 * One entry's contribution to a single model's totals, before merging across
 * entries. Mirrors CostModelTotal's numeric fields but stays entry-scoped.
 */
interface ModelContribution {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
  estimated: boolean;
}

/**
 * Flatten one entry into its per-model contributions. Entries without a
 * breakdown contribute a single row from their own top-level figures; entries
 * with a breakdown contribute one row per breakdown row instead of (never in
 * addition to) the top-level figures, since the top-level figures are already
 * the roll-up of the breakdown.
 */
function modelContributions(entry: CostEntry): ModelContribution[] {
  const estimated = entry.estimated === true;
  if (!entry.breakdown || entry.breakdown.length === 0) {
    return [
      {
        model: entry.model ?? "unknown",
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        cacheReadTokens: entry.cacheReadTokens ?? 0,
        cacheWriteTokens: entry.cacheWriteTokens ?? 0,
        costUsd: entry.costUsd,
        estimated,
      },
    ];
  }

  const contributions: ModelContribution[] = entry.breakdown.map((row) => ({
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens ?? 0,
    cacheWriteTokens: row.cacheWriteTokens ?? 0,
    costUsd: row.costUsd,
    estimated,
  }));

  // Codex sessions price at the session level: the entry carries a costUsd
  // but none of its breakdown rows do. Attribute it once so per-model costs
  // still sum to the run total, preferring the row matching the entry's own
  // model and falling back to the row with the most tokens.
  const hasRowCost = contributions.some((c) => c.costUsd !== undefined);
  if (entry.costUsd !== undefined && !hasRowCost) {
    let target = contributions.find((c) => c.model === entry.model);
    if (!target) {
      target = contributions.reduce((best, c) =>
        c.inputTokens + c.outputTokens > best.inputTokens + best.outputTokens ? c : best,
      );
    }
    target.costUsd = entry.costUsd;
  }

  return contributions;
}

/** Sum cost entries into run-level totals. */
export function summarizeCosts(entries: CostEntry[]): CostTotals {
  const totals: CostTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimated: false,
  };
  const byModel = new Map<string, CostModelTotal>();
  for (const entry of entries) {
    totals.inputTokens += entry.inputTokens;
    totals.outputTokens += entry.outputTokens;
    totals.cacheReadTokens += entry.cacheReadTokens ?? 0;
    totals.cacheWriteTokens += entry.cacheWriteTokens ?? 0;
    if (entry.costUsd !== undefined) totals.costUsd = (totals.costUsd ?? 0) + entry.costUsd;
    if (entry.estimated) totals.estimated = true;

    for (const contribution of modelContributions(entry)) {
      const existing = byModel.get(contribution.model);
      if (existing) {
        existing.inputTokens += contribution.inputTokens;
        existing.outputTokens += contribution.outputTokens;
        existing.cacheReadTokens += contribution.cacheReadTokens;
        existing.cacheWriteTokens += contribution.cacheWriteTokens;
        if (contribution.costUsd !== undefined) existing.costUsd = (existing.costUsd ?? 0) + contribution.costUsd;
        if (contribution.estimated) existing.estimated = true;
      } else {
        byModel.set(contribution.model, {
          model: contribution.model,
          inputTokens: contribution.inputTokens,
          outputTokens: contribution.outputTokens,
          cacheReadTokens: contribution.cacheReadTokens,
          cacheWriteTokens: contribution.cacheWriteTokens,
          costUsd: contribution.costUsd,
          estimated: contribution.estimated,
        });
      }
    }
  }

  totals.byModel = [...byModel.values()].sort((a, b) => {
    if (a.costUsd !== undefined && b.costUsd !== undefined) return b.costUsd - a.costUsd;
    if (a.costUsd !== undefined) return -1;
    if (b.costUsd !== undefined) return 1;
    return b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens);
  });

  return totals;
}

export interface RunResult {
  /** PR opened for the run. */
  prUrl?: string;
  /** Branch pushed for the run. */
  branch?: string;
  /**
   * ISO time of brevi's most recent push to the branch (the initial push or
   * a follow-up's). Follow-ups use it as the "comments since the last push"
   * cutoff; commit timestamps are no substitute, since a commit can be
   * authored long before it is pushed.
   */
  pushedAt?: string;
  summary: string;
  artifacts: ArtifactRef[];
  /** Total LLM usage of the run at completion, summed across cost entries. */
  costTotals?: CostTotals;
}

export interface Run {
  id: string;
  ticket: Ticket;
  status: RunStatus;
  sandbox: {
    /**
     * Which provider the run executed on. Absent while the run is still
     * queued: the sandbox lives on whichever worker picks the run up, so the
     * scheduling host only learns this once that worker reports it.
     */
    provider?: SandboxProviderName;
    /** Id of the worker that executed the run and holds its sandbox. */
    workerId?: string;
    /** Provider-specific sandbox id once booted. */
    id?: string;
    /**
     * When set, the sandbox's filesystem is retained until this ISO time so
     * the agent conversation can be resumed interactively; cleared once the
     * disk is reclaimed.
     */
    retainedUntil?: string;
  };
  /**
   * Agent session id captured from the Claude stream's init event, used to
   * resume the conversation with `claude --resume` inside the retained
   * sandbox. Absent for agents that don't report one (e.g. Codex).
   */
  agentSessionId?: string;
  createdAt: string;
  /** Time the run last entered the scheduler's FIFO queue (refreshed on requeue); queued runs start in ascending queuedAt order. */
  queuedAt?: string;
  /**
   * Why a queued run has not been dispatched yet (no worker is connected, the
   * fleet is at capacity, nothing can boot the VM size it asked for). Set by
   * the scheduler when placement finds no worker and cleared the moment the
   * run is dispatched, so a run card can say what it is waiting for.
   */
  queueReason?: string;
  startedAt?: string;
  finishedAt?: string;
  result?: RunResult;
  error?: string;
  /** One entry per agent execution, oldest first. */
  attempts: RunAttempt[];
  /** LLM usage per agent execution, oldest first; empty until an execution reports usage. */
  costs: CostEntry[];
  /** Derived sums over costs; recomputed whenever an entry is appended. */
  costTotals?: CostTotals;
  /**
   * URL of the ticket's pull request, kept at run level so it survives a
   * retry requeue (which clears result): set when a finished attempt opens
   * or updates the PR.
   */
  prUrl?: string;
  /**
   * Last observed GitHub state of the run's PR (prUrl): set to "open"
   * when the PR is created and refreshed by a lazy orchestrator poll until
   * the PR merges or closes. Absent while no PR exists.
   */
  prState?: PrState;
  /** When status is "waiting", the earliest time the next attempt may start. */
  resumeAt?: string;
  /** The most recent usage limit that interrupted this run. */
  limit?: LimitInfo;
}

/** A single line of run activity, persisted as JSONL and streamed to the dashboard. */
export type RunEvent =
  | { runId: string; ts: string; type: "status"; status: RunStatus }
  | { runId: string; ts: string; type: "log"; stream: "stdout" | "stderr" | "system"; text: string }
  | {
      runId: string;
      ts: string;
      type: "agent";
      /** Structured event forwarded from the coding agent's stream-json output. */
      event: unknown;
    }
  | {
      runId: string;
      ts: string;
      type: "thinking";
      /** Boundary of a thinking block in the agent's stream. */
      phase: "started" | "finished";
      /** How long the block took, present on "finished". */
      durationMs?: number;
    }
  | { runId: string; ts: string; type: "artifact"; artifact: ArtifactRef }
  /** LLM usage of one finished agent execution. */
  | { runId: string; ts: string; type: "cost"; entry: CostEntry }
  /**
   * An agent usage limit ended an execution. The run's own `limit` and
   * `resumeAt` carry the current state; this records the moment it was hit,
   * so the console shows why an attempt stopped where it did.
   */
  | { runId: string; ts: string; type: "limit"; limit: LimitInfo }
  /** Marks the start of an agent execution; events that follow belong to it. */
  | { runId: string; ts: string; type: "attempt"; number: number };

/**
 * One durable fact a run learned about a repository, kept on the host and
 * injected into later runs' prompts. Memories outlive the sandbox they were
 * recorded in: a fresh microVM starts with what the last run figured out
 * instead of re-exploring the repo from zero.
 */
export interface RepoMemory {
  /** Stable id, used to delete a single memory from the dashboard. */
  id: string;
  /** The fact itself, one line as the agent wrote it. */
  text: string;
  createdAt: string;
  /** Last time a run recorded this same fact; drives eviction order. */
  updatedAt: string;
  /** How many runs have recorded it. A repeatedly rediscovered fact is a load-bearing one. */
  hits: number;
  /** Ticket that last recorded it, for provenance in the dashboard. */
  ident?: string;
}
