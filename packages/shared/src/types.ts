/** Core domain types shared between the orchestrator, sandbox, CLI, and dashboard. */

/** How a ticket should be handled. SPIKEs produce research; everything else produces code. */
export type TicketKind = "spike" | "implementation";

export interface Ticket {
  /** Provider-scoped id (e.g. Linear issue id). */
  id: string;
  /** Human identifier, e.g. "ENG-123". */
  identifier: string;
  title: string;
  description: string;
  url: string;
  kind: TicketKind;
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

export interface RunResult {
  kind: TicketKind;
  /** PR opened for implementation runs. */
  prUrl?: string;
  /** Linear comment posted for spike runs. */
  commentUrl?: string;
  /** Branch pushed for implementation runs. */
  branch?: string;
  summary: string;
  artifacts: ArtifactRef[];
}

export interface Run {
  id: string;
  ticket: Ticket;
  status: RunStatus;
  sandbox: {
    provider: SandboxProviderName;
    /** Provider-specific sandbox id once booted. */
    id?: string;
  };
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: RunResult;
  error?: string;
  /** One entry per agent execution, oldest first. */
  attempts: RunAttempt[];
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
  /** Marks the start of an agent execution; events that follow belong to it. */
  | { runId: string; ts: string; type: "attempt"; number: number };
