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
export type LimitProvider = "claude" | "codex";

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
 * One agent execution within a run. A run retried after a usage limit (or
 * manually) accumulates attempts; each attempt's output is preserved in the
 * run's event log between its "attempt" markers.
 */
export interface RunAttempt {
  /** 1-based sequence number within the run. */
  number: number;
  startedAt: string;
  finishedAt?: string;
  outcome?: AttemptOutcome;
  /** Failure detail when the outcome is "failed". */
  error?: string;
  /** The usage limit that ended this attempt, when the outcome is "limit". */
  limit?: LimitInfo;
}

export type SandboxProviderName = "firecracker" | "process";

export interface ArtifactRef {
  /** File name within the run's artifact directory. */
  name: string;
  type: "screenshot" | "recording" | "document" | "log" | "other";
  /** Size in bytes at capture time. */
  size: number;
}

/**
 * LLM usage and cost of one agent execution within a run. Generic over
 * providers and phases: a run is N executions (attempts today, more phases or
 * subagents later), and the run's total is the sum over its entries.
 */
export interface CostEntry {
  /** Which execution produced it, e.g. "implementation", "review fixes", "implementation (attempt 2)". */
  label: string;
  /** "claude" | "codex" | future providers. */
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
  for (const entry of entries) {
    totals.inputTokens += entry.inputTokens;
    totals.outputTokens += entry.outputTokens;
    totals.cacheReadTokens += entry.cacheReadTokens ?? 0;
    totals.cacheWriteTokens += entry.cacheWriteTokens ?? 0;
    if (entry.costUsd !== undefined) totals.costUsd = (totals.costUsd ?? 0) + entry.costUsd;
    if (entry.estimated) totals.estimated = true;
  }
  return totals;
}

export interface RunResult {
  /** PR opened for the run. */
  prUrl?: string;
  /** Branch pushed for the run. */
  branch?: string;
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
    provider: SandboxProviderName;
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
  /** Marks the start of an agent execution; events that follow belong to it. */
  | { runId: string; ts: string; type: "attempt"; number: number };
