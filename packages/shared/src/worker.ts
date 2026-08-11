import { z } from "zod";
import { configSchema, repoConfigSchema } from "./config.js";
import type {
  ArtifactRef,
  CostEntry,
  CostModelTotal,
  CostModelUsage,
  CostTotals,
  LimitInfo,
  PrState,
  Run,
  RunAttempt,
  RunEvent,
  RunResult,
  RunStatus,
  SandboxProviderName,
  Ticket,
} from "./types.js";

/**
 * The wire protocol between a `brevi worker` daemon and the orchestrator
 * host. A worker is a machine willing to execute runs; the host is a pure
 * scheduler that never touches a sandbox itself (see the `fleet` config
 * section in config.ts). Every worker dials the host over a single outbound
 * WebSocket at WORKER_WS_PATH and exchanges the messages below.
 *
 * This module is node-agnostic, like config.ts, but unlike config.ts it is
 * not imported by the browser dashboard bundle, so it may freely import the
 * domain types (types.ts) and the config schema (config.ts) it mirrors and
 * embeds.
 */

export const WORKER_PROTOCOL_VERSION = 1;
/** WebSocket path workers dial on the host. */
export const WORKER_WS_PATH = "/ws/worker";
/** How often a connected worker sends a heartbeat. */
export const WORKER_HEARTBEAT_MS = 15_000;
/** A worker missing this many consecutive heartbeats is treated as gone. */
export const WORKER_HEARTBEAT_TIMEOUT_MS = 45_000;
/** Largest artifact the worker streams back inline, in bytes. */
export const WORKER_MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
/**
 * Most concurrent runs one worker may claim. The registration schema rejects
 * anything above this, so `brevi worker --concurrency` validates against the
 * same constant rather than letting a too-large value produce a registration
 * the host silently drops.
 */
export const WORKER_MAX_CONCURRENCY = 64;

/**
 * Compile-time assertion that a wire schema and the domain interface it
 * mirrors stay in step: the alias resolves to `true` only when the two types
 * are mutually assignable, so drift in either direction fails check-types.
 */
type InSync<Schema, Domain> = Schema extends Domain ? (Domain extends Schema ? true : never) : never;

// --- Zod mirrors of the run domain (types.ts) --------------------------
//
// Dispatch and run reporting travel over the wire as plain JSON, so every
// shape the host and worker exchange is validated against a schema that
// mirrors its types.ts interface field for field. Optional fields stay
// `.optional()` (never `.default()`) so the inferred type matches the
// interface exactly, and each schema is immediately followed by an `InSync`
// alias that fails check-types the moment the two definitions disagree.

export const ticketSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string(),
  url: z.string(),
  labels: z.array(z.string()),
  state: z.string(),
  repo: z.string().optional(),
  updatedAt: z.string(),
});
export type TicketInSync = InSync<z.infer<typeof ticketSchema>, Ticket>;

export const limitInfoSchema = z.object({
  provider: z.enum(["claude", "codex"]),
  kind: z.enum(["five-hour", "weekly", "unknown"]),
  resetsAt: z.string().optional(),
  message: z.string(),
});
export type LimitInfoInSync = InSync<z.infer<typeof limitInfoSchema>, LimitInfo>;

export const runAttemptSchema = z.object({
  number: z.number(),
  startedAt: z.string(),
  kind: z.literal("follow-up").optional(),
  finishedAt: z.string().optional(),
  outcome: z.enum(["completed", "failed", "cancelled", "limit"]).optional(),
  error: z.string().optional(),
  limit: limitInfoSchema.optional(),
});
export type RunAttemptInSync = InSync<z.infer<typeof runAttemptSchema>, RunAttempt>;

export const artifactRefSchema = z.object({
  name: z.string(),
  type: z.enum(["screenshot", "recording", "document", "log", "other"]),
  size: z.number(),
});
export type ArtifactRefInSync = InSync<z.infer<typeof artifactRefSchema>, ArtifactRef>;

export const costModelUsageSchema = z.object({
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
  costUsd: z.number().optional(),
});
export type CostModelUsageInSync = InSync<z.infer<typeof costModelUsageSchema>, CostModelUsage>;

export const costEntrySchema = z.object({
  label: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
  costUsd: z.number().optional(),
  estimated: z.boolean().optional(),
  breakdown: z.array(costModelUsageSchema).optional(),
});
export type CostEntryInSync = InSync<z.infer<typeof costEntrySchema>, CostEntry>;

export const costModelTotalSchema = z.object({
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  costUsd: z.number().optional(),
  estimated: z.boolean(),
});
export type CostModelTotalInSync = InSync<z.infer<typeof costModelTotalSchema>, CostModelTotal>;

export const costTotalsSchema = z.object({
  costUsd: z.number().optional(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  estimated: z.boolean(),
  byModel: z.array(costModelTotalSchema).optional(),
});
export type CostTotalsInSync = InSync<z.infer<typeof costTotalsSchema>, CostTotals>;

export const runResultSchema = z.object({
  prUrl: z.string().optional(),
  branch: z.string().optional(),
  pushedAt: z.string().optional(),
  summary: z.string(),
  artifacts: z.array(artifactRefSchema),
  costTotals: costTotalsSchema.optional(),
});
export type RunResultInSync = InSync<z.infer<typeof runResultSchema>, RunResult>;

export const runStatusSchema = z.enum([
  "queued",
  "preparing",
  "running",
  "finalizing",
  "waiting",
  "completed",
  "failed",
  "cancelled",
]);
export type RunStatusInSync = InSync<z.infer<typeof runStatusSchema>, RunStatus>;

export const prStateSchema = z.enum(["open", "draft", "merged", "closed"]);
export type PrStateInSync = InSync<z.infer<typeof prStateSchema>, PrState>;

export const sandboxProviderNameSchema = z.enum(["firecracker", "process"]);
export type SandboxProviderNameInSync = InSync<z.infer<typeof sandboxProviderNameSchema>, SandboxProviderName>;

export const runSchema = z.object({
  id: z.string(),
  ticket: ticketSchema,
  status: runStatusSchema,
  sandbox: z.object({
    /** Absent while the run is queued; the worker that picks it up reports it. */
    provider: sandboxProviderNameSchema.optional(),
    /** Id of the worker that executed the run and holds its sandbox. */
    workerId: z.string().optional(),
    /** Provider-specific sandbox id once booted. */
    id: z.string().optional(),
    /**
     * When set, the sandbox's filesystem is retained until this ISO time so
     * the agent conversation can be resumed interactively; cleared once the
     * disk is reclaimed.
     */
    retainedUntil: z.string().optional(),
  }),
  agentSessionId: z.string().optional(),
  createdAt: z.string(),
  queuedAt: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  result: runResultSchema.optional(),
  error: z.string().optional(),
  attempts: z.array(runAttemptSchema),
  costs: z.array(costEntrySchema),
  costTotals: costTotalsSchema.optional(),
  prUrl: z.string().optional(),
  prState: prStateSchema.optional(),
  resumeAt: z.string().optional(),
  limit: limitInfoSchema.optional(),
});
export type RunInSync = InSync<z.infer<typeof runSchema>, Run>;

export const runEventSchema = z.discriminatedUnion("type", [
  z.object({ runId: z.string(), ts: z.string(), type: z.literal("status"), status: runStatusSchema }),
  z.object({
    runId: z.string(),
    ts: z.string(),
    type: z.literal("log"),
    stream: z.enum(["stdout", "stderr", "system"]),
    text: z.string(),
  }),
  z.object({
    runId: z.string(),
    ts: z.string(),
    type: z.literal("agent"),
    /** Structured event forwarded from the coding agent's stream-json output. */
    event: z.unknown(),
  }),
  z.object({
    runId: z.string(),
    ts: z.string(),
    type: z.literal("thinking"),
    phase: z.enum(["started", "finished"]),
    durationMs: z.number().optional(),
  }),
  z.object({ runId: z.string(), ts: z.string(), type: z.literal("artifact"), artifact: artifactRefSchema }),
  z.object({ runId: z.string(), ts: z.string(), type: z.literal("cost"), entry: costEntrySchema }),
  z.object({ runId: z.string(), ts: z.string(), type: z.literal("limit"), limit: limitInfoSchema }),
  z.object({ runId: z.string(), ts: z.string(), type: z.literal("attempt"), number: z.number() }),
]);
export type RunEventInSync = InSync<z.infer<typeof runEventSchema>, RunEvent>;

// --- Capabilities and lease ---------------------------------------------

export const workerCapabilitiesSchema = z.object({
  /** process.platform of the worker host, e.g. "linux". */
  os: z.string(),
  arch: z.string(),
  /** Sandbox provider the worker resolved locally. */
  provider: sandboxProviderNameSchema,
  /** True when /dev/kvm is usable, so the host can tell isolated workers apart. */
  kvm: z.boolean(),
  /** How many dispatched runs this worker executes at once. */
  maxConcurrency: z.number().int().min(1).max(WORKER_MAX_CONCURRENCY),
  /** Firecracker VM size presets this worker can boot; empty for process workers. */
  vmSizes: z.array(z.enum(["small", "medium", "large"])).default([]),
  /** @brevi/cli version the worker runs. */
  version: z.string(),
});
export type WorkerCapabilities = z.infer<typeof workerCapabilitiesSchema>;

export const runLeaseSchema = z.object({
  /** Unique per dispatch, so a retried dispatch of the same run is distinguishable. */
  id: z.string().min(1),
  runId: z.string().min(1),
  issuedAt: z.string(),
  /** When the host stops expecting this lease's worker to report; absent = no deadline yet (Fleet 3 owns expiry policy). */
  expiresAt: z.string().optional(),
});
export type RunLease = z.infer<typeof runLeaseSchema>;

// --- The run patch --------------------------------------------------------
//
// Run reporting mirrors the host's run store mutations. JSON drops keys
// whose value is `undefined`, and the runner clears a field (finishedAt,
// error, result, ...) by setting it to `undefined` in memory, so that
// convention cannot travel over the wire as-is: here `null` means "clear
// this field" and omitting the key entirely means "leave it alone".

export const runPatchSchema = z
  .object({
    status: runStatusSchema.nullable(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    queuedAt: z.string().nullable(),
    error: z.string().nullable(),
    resumeAt: z.string().nullable(),
    agentSessionId: z.string().nullable(),
    limit: limitInfoSchema.nullable(),
    result: runResultSchema.nullable(),
    prUrl: z.string().nullable(),
    prState: prStateSchema.nullable(),
    attempts: z.array(runAttemptSchema).nullable(),
    costs: z.array(costEntrySchema).nullable(),
    costTotals: costTotalsSchema.nullable(),
    /**
     * A patch, not a replacement: the host merges these onto the sandbox
     * fields it already holds. Every field follows the same rule as the
     * top-level ones (`null` clears it, an absent key leaves it alone), so a
     * worker reporting a destroyed sandbox can retract the id it reported
     * earlier. `workerId` is deliberately absent, because it records which
     * worker owns the run and the host derives that from the lease; a worker
     * reporting its sandbox must not be able to drop or reassign it.
     */
    sandbox: z
      .object({
        provider: sandboxProviderNameSchema.nullable().optional(),
        id: z.string().nullable().optional(),
        retainedUntil: z.string().nullable().optional(),
      })
      .nullable(),
  })
  .partial();
export type RunPatch = z.infer<typeof runPatchSchema>;

// --- Worker -> host messages ---------------------------------------------

export const registerMessageSchema = z.object({
  type: z.literal("register"),
  protocolVersion: z.number(),
  /** Stable per machine, so a reconnect is recognised as the same worker. */
  workerId: z.string().min(1),
  name: z.string().min(1),
  token: z.string(),
  capabilities: workerCapabilitiesSchema,
  /** What the worker still believes it owns, so in-flight run reporting resumes after a drop. */
  activeLeases: z.array(runLeaseSchema).default([]),
});
export type RegisterMessage = z.infer<typeof registerMessageSchema>;

export const heartbeatMessageSchema = z.object({
  type: z.literal("heartbeat"),
  ts: z.string(),
  leaseIds: z.array(z.string()).default([]),
});
export type HeartbeatMessage = z.infer<typeof heartbeatMessageSchema>;

export const dispatchAcceptedMessageSchema = z.object({
  type: z.literal("dispatch-accepted"),
  leaseId: z.string(),
  runId: z.string(),
});
export type DispatchAcceptedMessage = z.infer<typeof dispatchAcceptedMessageSchema>;

export const dispatchRejectedMessageSchema = z.object({
  type: z.literal("dispatch-rejected"),
  leaseId: z.string(),
  runId: z.string(),
  /** Worker at capacity, unsupported request, ... */
  reason: z.string(),
});
export type DispatchRejectedMessage = z.infer<typeof dispatchRejectedMessageSchema>;

export const runPatchMessageSchema = z.object({
  type: z.literal("run-patch"),
  leaseId: z.string(),
  runId: z.string(),
  patch: runPatchSchema,
});
export type RunPatchMessage = z.infer<typeof runPatchMessageSchema>;

export const runEventMessageSchema = z.object({
  type: z.literal("run-event"),
  leaseId: z.string(),
  runId: z.string(),
  event: runEventSchema,
});
export type RunEventMessage = z.infer<typeof runEventMessageSchema>;

export const runArtifactMessageSchema = z.object({
  type: z.literal("run-artifact"),
  leaseId: z.string(),
  runId: z.string(),
  artifact: artifactRefSchema,
  /** Base64-encoded artifact bytes; the host writes it into the run's artifact directory. The worker must not send more than WORKER_MAX_ARTIFACT_BYTES of decoded data. */
  data: z.string(),
});
export type RunArtifactMessage = z.infer<typeof runArtifactMessageSchema>;

export const runMemoriesMessageSchema = z.object({
  type: z.literal("run-memories"),
  leaseId: z.string(),
  runId: z.string(),
  /** Repo remote ("owner/name") the memories belong to. */
  repo: z.string(),
  ident: z.string().optional(),
  /** Facts the run wrote to .brevi/memories.md; the host owns the memory store, so it records them and logs the outcome. */
  learned: z.array(z.string()),
});
export type RunMemoriesMessage = z.infer<typeof runMemoriesMessageSchema>;

/**
 * The last word on a dispatched run: it releases the lease, tells the host
 * which follow-on timer to arm, and carries the run's whole terminal state a
 * second time. The individual mutations already travelled as run-patch
 * frames, but a socket that dropped mid-run can lose some of them, and this
 * frame is the one the worker holds its lease open for until the host has it
 * (see the reconnect replay in the worker's connection). Applying it makes
 * the host's copy of a finished run correct even when nothing between the
 * dispatch and here got through.
 */
export const runCompleteMessageSchema = z.object({
  type: z.literal("run-complete"),
  leaseId: z.string(),
  runId: z.string(),
  /** Terminal (or parked) status the run ended in; the host writes it as the run's status. */
  outcome: z.enum(["completed", "failed", "cancelled", "waiting"]),
  finishedAt: z.string().optional(),
  error: z.string().optional(),
  /** Summary, PR, branch, artifacts and cost totals of a run that produced one. */
  result: runResultSchema.optional(),
  /**
   * Every artifact the worker transferred under this lease. The bytes
   * travelled as run-artifact frames; this manifest is what lets the host
   * notice one that never arrived and say so on the run's console.
   */
  artifacts: z.array(artifactRefSchema).default([]),
  prUrl: z.string().optional(),
  prState: prStateSchema.optional(),
  /** Set when the run parked on an agent usage limit ("waiting"); resumeAt is when the host should probe again. */
  limit: limitInfoSchema.optional(),
  resumeAt: z.string().optional(),
  attempts: z.array(runAttemptSchema).default([]),
  costs: z.array(costEntrySchema).default([]),
  costTotals: costTotalsSchema.optional(),
  agentSessionId: z.string().optional(),
  /** Where the run's sandbox ended up, including a retention window the host has to reap later. */
  sandbox: z
    .object({
      provider: sandboxProviderNameSchema.optional(),
      id: z.string().optional(),
      retainedUntil: z.string().optional(),
    })
    .optional(),
});
export type RunCompleteMessage = z.infer<typeof runCompleteMessageSchema>;

export const workerLogMessageSchema = z.object({
  type: z.literal("worker-log"),
  level: z.enum(["info", "warn", "error"]),
  /** Worker diagnostics surfaced on the host console. */
  message: z.string(),
});
export type WorkerLogMessage = z.infer<typeof workerLogMessageSchema>;

// --- Interactive attach ----------------------------------------------------
//
// A finished run's retained sandbox lives on the worker that executed it, so
// `brevi attach` and the dashboard's web terminal cannot reach it directly.
// The worker runs the PTY (a local shell for the process provider, `ssh -t`
// into the guest for Firecracker) and the host relays its bytes between that
// PTY and the browser or CLI socket. Terminal bytes travel as UTF-8 strings,
// exactly as they already do on the dashboard's attach socket.

export const attachDataMessageSchema = z.object({
  type: z.literal("attach-data"),
  attachId: z.string(),
  data: z.string(),
});
export type AttachDataMessage = z.infer<typeof attachDataMessageSchema>;

export const attachExitMessageSchema = z.object({
  type: z.literal("attach-exit"),
  attachId: z.string(),
  code: z.number(),
});
export type AttachExitMessage = z.infer<typeof attachExitMessageSchema>;

export const attachErrorMessageSchema = z.object({
  type: z.literal("attach-error"),
  attachId: z.string(),
  /** Why the session could not start (no retained disk, boot failure, ...). */
  message: z.string(),
});
export type AttachErrorMessage = z.infer<typeof attachErrorMessageSchema>;

export const workerMessageSchema = z.discriminatedUnion("type", [
  registerMessageSchema,
  heartbeatMessageSchema,
  dispatchAcceptedMessageSchema,
  dispatchRejectedMessageSchema,
  runPatchMessageSchema,
  runEventMessageSchema,
  runArtifactMessageSchema,
  runMemoriesMessageSchema,
  runCompleteMessageSchema,
  workerLogMessageSchema,
  attachDataMessageSchema,
  attachExitMessageSchema,
  attachErrorMessageSchema,
]);
export type WorkerMessage = z.infer<typeof workerMessageSchema>;

// --- Host -> worker messages -----------------------------------------------

export const registeredMessageSchema = z.object({
  type: z.literal("registered"),
  protocolVersion: z.number(),
  heartbeatIntervalMs: z.number(),
  hostVersion: z.string(),
  workerId: z.string(),
});
export type RegisteredMessage = z.infer<typeof registeredMessageSchema>;

export const rejectedMessageSchema = z.object({
  type: z.literal("rejected"),
  /** Bad pairing token, protocol mismatch, ... The host closes the socket right after sending this. */
  reason: z.string(),
});
export type RejectedMessage = z.infer<typeof rejectedMessageSchema>;

/**
 * What the host decides about the run's prompts, sent explicitly rather than
 * left for the worker to re-derive from the dispatched config. Prompt policy
 * is the host's (it owns the memory store and the PR conventions); the parts
 * that can only be known once the repository is checked out (its file map,
 * the PR's review feedback, whether a rebase conflicted) are composed into
 * the final prompt by the worker, because nothing on the host can know them.
 */
export const dispatchPromptsSchema = z.object({
  /** How verbose the `.brevi/summary.md` the agent writes (the PR description) should be. */
  prDescription: z.enum(["concise", "detailed"]),
  /** Facts earlier runs recorded about this repo, already selected and budgeted by the host. */
  memories: z.array(z.string()).default([]),
  /** Ask the agent to write `.brevi/memories.md` back, so this run's learning reaches the host's memory store. */
  recordMemories: z.boolean().default(false),
});
export type DispatchPrompts = z.infer<typeof dispatchPromptsSchema>;

export const dispatchMessageSchema = z.object({
  type: z.literal("dispatch"),
  lease: runLeaseSchema,
  kind: z.enum(["implementation", "follow-up"]),
  run: runSchema,
  repoKey: z.string(),
  repo: repoConfigSchema,
  prompts: dispatchPromptsSchema,
  /**
   * The per-run credentials the run needs (GitHub token, agent keys, Linear
   * key). The worker overrides the sandbox provider fields (`sandbox.*`)
   * with its own local ones instead of trusting the host's copy, since a
   * worker's provider and Firecracker image paths are local to its machine.
   */
  config: configSchema,
});
export type DispatchMessage = z.infer<typeof dispatchMessageSchema>;

export const cancelMessageSchema = z.object({
  type: z.literal("cancel"),
  leaseId: z.string(),
  runId: z.string(),
});
export type CancelMessage = z.infer<typeof cancelMessageSchema>;

/**
 * The host has applied a run-complete and released the lease. Until this
 * arrives the worker keeps claiming that lease in its `register` frames, so
 * a run that finished during a disconnect replays its terminal reporting on
 * the next connection instead of being stranded as a disconnect failure.
 */
export const runCompleteAckMessageSchema = z.object({
  type: z.literal("run-complete-ack"),
  leaseId: z.string(),
  runId: z.string(),
});
export type RunCompleteAckMessage = z.infer<typeof runCompleteAckMessageSchema>;

export const discardMessageSchema = z.object({
  type: z.literal("discard"),
  /** Drop a retained sandbox disk the worker still holds, e.g. its retention window ended or the run was retried. */
  runId: z.string(),
});
export type DiscardMessage = z.infer<typeof discardMessageSchema>;

export const heartbeatAckMessageSchema = z.object({
  type: z.literal("heartbeat-ack"),
  ts: z.string(),
});
export type HeartbeatAckMessage = z.infer<typeof heartbeatAckMessageSchema>;

export const attachOpenMessageSchema = z.object({
  type: z.literal("attach-open"),
  /** Correlates every frame of one interactive session; unique per open. */
  attachId: z.string(),
  runId: z.string(),
  /**
   * Credentials for the session: provisioning runs again on every attach, so
   * a rotated key reaches a sandbox retained before it was connected.
   */
  config: configSchema,
  cols: z.number().int().min(1).max(1000).default(80),
  rows: z.number().int().min(1).max(1000).default(24),
});
export type AttachOpenMessage = z.infer<typeof attachOpenMessageSchema>;

export const attachInputMessageSchema = z.object({
  type: z.literal("attach-input"),
  attachId: z.string(),
  data: z.string(),
});
export type AttachInputMessage = z.infer<typeof attachInputMessageSchema>;

export const attachResizeMessageSchema = z.object({
  type: z.literal("attach-resize"),
  attachId: z.string(),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
});
export type AttachResizeMessage = z.infer<typeof attachResizeMessageSchema>;

export const attachCloseMessageSchema = z.object({
  type: z.literal("attach-close"),
  attachId: z.string(),
});
export type AttachCloseMessage = z.infer<typeof attachCloseMessageSchema>;

export const hostMessageSchema = z.discriminatedUnion("type", [
  registeredMessageSchema,
  rejectedMessageSchema,
  dispatchMessageSchema,
  cancelMessageSchema,
  runCompleteAckMessageSchema,
  discardMessageSchema,
  heartbeatAckMessageSchema,
  attachOpenMessageSchema,
  attachInputMessageSchema,
  attachResizeMessageSchema,
  attachCloseMessageSchema,
]);
export type HostMessage = z.infer<typeof hostMessageSchema>;

/**
 * The only decode path either side should use: takes an already-JSON-parsed
 * value and returns undefined on a validation failure, so a caller ignores
 * an unknown or malformed frame instead of crashing the socket on it.
 */
export function parseWorkerMessage(raw: unknown): WorkerMessage | undefined {
  const result = workerMessageSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

/** See parseWorkerMessage; the host-to-worker counterpart. */
export function parseHostMessage(raw: unknown): HostMessage | undefined {
  const result = hostMessageSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

/** The dashboard's view of one connected worker. */
export interface WorkerSummary {
  id: string;
  name: string;
  provider: SandboxProviderName;
  kvm: boolean;
  maxConcurrency: number;
  /** Runs the worker currently has an active lease for. */
  activeRuns: number;
  version: string;
  connectedAt: string;
  lastSeenAt: string;
  os: string;
  arch: string;
}
