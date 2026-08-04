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
  | "completed"
  | "failed"
  | "cancelled";

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
  | { runId: string; ts: string; type: "artifact"; artifact: ArtifactRef };
