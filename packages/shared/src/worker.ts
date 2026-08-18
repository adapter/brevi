import { z } from "zod";
import { configSchema, repoConfigSchema } from "./config.js";
import type { WorkerState } from "./fleet.js";
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
 * Who a worker is, and whether it is allowed here at all, is enrollment's
 * question and is answered in fleet.ts: the `register` frame carries either a
 * single-use pairing token or the durable credential redeeming one bought.
 *
 * This module is node-agnostic, like config.ts, so it may freely import the
 * domain types (types.ts) and the config schema (config.ts) it mirrors and
 * embeds. The dashboard bundle reaches it only for the odd plain constant
 * (MACOS_VM_OS), never for the schemas.
 */

/**
 * 3 since bwrap-only isolation: a version-2 worker can still register with a
 * non-bwrap provider, and the host would dispatch unisolated runs. A
 * version-2 frame is rejected on registration.
 *
 * 2 since enrollment: `register` carries an auth envelope instead of a shared
 * pairing token, and the host answers with the worker's assigned id, so a
 * version-1 worker's frame is not merely older, it is unauthenticatable.
 */
export const WORKER_PROTOCOL_VERSION = 3;
/** WebSocket path workers dial on the host. */
export const WORKER_WS_PATH = "/ws/worker";
/**
 * HTTP path a worker's supervisor polls for demand (see FleetDemandResponse),
 * served on the same two listeners the worker channel is: the fleet listener
 * and the dashboard's own. It carries the same durable per-worker credential
 * the channel authenticates with, in an `Authorization: Bearer` header, and
 * names its worker with `?workerId=`.
 */
export const WORKER_DEMAND_PATH = "/api/worker/demand";
/**
 * HTTP path a worker's supervisor posts to in order to set its own worker's
 * state (`?state=draining` or `?state=active`), authenticated with the same
 * credential as WORKER_DEMAND_PATH and answered with the same
 * FleetDemandResponse.
 *
 * It exists so powering a machine down can be made atomic with dispatch.
 * Demand is only ever a snapshot: between reading it and cutting the power, a
 * run can be queued and dispatched to a worker that is still online, and it
 * would die with the machine. Draining first closes that window, because the
 * scheduler stops placing runs on this worker before the answer comes back;
 * whatever the answer then reports as in flight is the complete set of work
 * that could be lost, and the supervisor can abandon the shutdown if it is
 * not empty.
 */
export const WORKER_SELF_STATE_PATH = "/api/worker/state";
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
 * Most lease-scoped reporting frames a worker retains per lease so a host
 * that missed them (a restart, a network blip) can have them replayed. Once
 * over the limit the oldest droppable frame goes first; a `run-complete` is
 * never dropped.
 */
export const WORKER_REPLAY_BUFFER_LIMIT = 2_000;

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
  provider: z.enum(["claude", "codex", "grok"]),
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

export const sandboxProviderNameSchema = z.string().min(1);
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
  /** Why a queued run has not been dispatched yet; mirrors Run.queueReason. */
  queueReason: z.string().optional(),
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

/** Env var a managed guest VM sets so its worker reports the machine it really runs on. */
export const WORKER_OS_ENV = "BREVI_WORKER_OS";
/** The one non-platform os label: a Linux worker inside brevi's managed macOS VM. */
export const MACOS_VM_OS = "macos-vm";

/**
 * The os capability a worker reports: `platform` (`process.platform`) as-is,
 * except when `env[WORKER_OS_ENV]` trimmed and lowercased equals
 * `MACOS_VM_OS`, in which case it reports `MACOS_VM_OS` instead. A
 * whitelist, not a passthrough: any other value of the env var is ignored,
 * so a worker cannot use it to claim an arbitrary os label.
 */
export function resolveWorkerOs(platform: string, env: Record<string, string | undefined>): string {
  const override = env[WORKER_OS_ENV];
  return override !== undefined && override.trim().toLowerCase() === MACOS_VM_OS ? MACOS_VM_OS : platform;
}

export const workerCapabilitiesSchema = z.object({
  /** process.platform of the worker host, e.g. "linux"; the managed macOS VM's worker reports MACOS_VM_OS ("macos-vm") instead (see resolveWorkerOs). */
  os: z.string(),
  arch: z.string(),
  /** Sandbox provider the worker runs. Only bwrap workers may register. */
  provider: z.literal("bwrap"),
  /** Agent commands this worker resolved on its own PATH at registration time. */
  agentCommands: z.array(z.string().min(1)).min(1),
  /** How many dispatched runs this worker executes at once. */
  maxConcurrency: z.number().int().min(1).max(WORKER_MAX_CONCURRENCY),
  /** Dedicated brevi-worker release version. */
  version: z.string(),
});
export type WorkerCapabilities = z.infer<typeof workerCapabilitiesSchema>;

export const runLeaseSchema = z.object({
  /** Unique per dispatch, so a retried dispatch of the same run is distinguishable. */
  id: z.string().min(1),
  runId: z.string().min(1),
  issuedAt: z.string(),
  /**
   * When the host stops expecting this lease's worker to report. Renewed on
   * every heartbeat; once it passes with no contact the host expires the
   * lease, marks the run interrupted and requeues it.
   */
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

export const workerStateSchema = z.enum(["active", "draining"]);
export type WorkerStateInSync = InSync<z.infer<typeof workerStateSchema>, WorkerState>;

/**
 * How a connecting worker proves who it is. "pairing" is the one-time
 * enrollment path and is answered with a durable credential plus the worker id
 * the host assigned; every later connect uses "credential", which carries that
 * id, so identity comes from enrollment rather than from anything the worker
 * gets to choose for itself.
 */
export const workerAuthSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pairing"), token: z.string().min(1) }),
  z.object({ kind: z.literal("credential"), workerId: z.string().min(1), secret: z.string().min(1) }),
]);
export type WorkerAuth = z.infer<typeof workerAuthSchema>;

export const registerMessageSchema = z.object({
  type: z.literal("register"),
  protocolVersion: z.number(),
  auth: workerAuthSchema,
  /** Preferred display name, honoured only when enrolling; the host's own choice wins afterwards. */
  name: z.string().min(1),
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
  /**
   * Position of this frame in its lease's reporting stream, assigned by the
   * worker's connection and strictly increasing per lease. The host applies a
   * frame only when its seq is above the highest it has already applied for
   * that lease, which is what makes a replay after a reconnect idempotent
   * rather than a duplicated console. Absent from a worker that predates
   * buffered replay; such a frame is always applied.
   */
  seq: z.number().int().nonnegative().optional(),
});
export type RunPatchMessage = z.infer<typeof runPatchMessageSchema>;

export const runEventMessageSchema = z.object({
  type: z.literal("run-event"),
  leaseId: z.string(),
  runId: z.string(),
  event: runEventSchema,
  /**
   * Position of this frame in its lease's reporting stream, assigned by the
   * worker's connection and strictly increasing per lease. The host applies a
   * frame only when its seq is above the highest it has already applied for
   * that lease, which is what makes a replay after a reconnect idempotent
   * rather than a duplicated console. Absent from a worker that predates
   * buffered replay; such a frame is always applied.
   */
  seq: z.number().int().nonnegative().optional(),
});
export type RunEventMessage = z.infer<typeof runEventMessageSchema>;

export const runArtifactMessageSchema = z.object({
  type: z.literal("run-artifact"),
  leaseId: z.string(),
  runId: z.string(),
  artifact: artifactRefSchema,
  /** Base64-encoded artifact bytes; the host writes it into the run's artifact directory. The worker must not send more than WORKER_MAX_ARTIFACT_BYTES of decoded data. */
  data: z.string(),
  /**
   * Position of this frame in its lease's reporting stream, assigned by the
   * worker's connection and strictly increasing per lease. The host applies a
   * frame only when its seq is above the highest it has already applied for
   * that lease, which is what makes a replay after a reconnect idempotent
   * rather than a duplicated console. Absent from a worker that predates
   * buffered replay; such a frame is always applied.
   */
  seq: z.number().int().nonnegative().optional(),
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
  /**
   * Position of this frame in its lease's reporting stream, assigned by the
   * worker's connection and strictly increasing per lease. The host applies a
   * frame only when its seq is above the highest it has already applied for
   * that lease, which is what makes a replay after a reconnect idempotent
   * rather than a duplicated console. Absent from a worker that predates
   * buffered replay; such a frame is always applied.
   */
  seq: z.number().int().nonnegative().optional(),
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
  /**
   * Position of this frame in its lease's reporting stream, assigned by the
   * worker's connection and strictly increasing per lease. The host applies a
   * frame only when its seq is above the highest it has already applied for
   * that lease, which is what makes a replay after a reconnect idempotent
   * rather than a duplicated console. Absent from a worker that predates
   * buffered replay; such a frame is always applied.
   */
  seq: z.number().int().nonnegative().optional(),
});
export type RunCompleteMessage = z.infer<typeof runCompleteMessageSchema>;

export const workerLogMessageSchema = z.object({
  type: z.literal("worker-log"),
  level: z.enum(["info", "warn", "error"]),
  /** Worker diagnostics surfaced on the host console. */
  message: z.string(),
});
export type WorkerLogMessage = z.infer<typeof workerLogMessageSchema>;

/**
 * Frames the worker will never be able to deliver, so the host stops waiting
 * for them. The escape hatch for the one thing that would otherwise wedge the
 * protocol: the host's watermark is the contiguous applied prefix and will not
 * step over a missing sequence number, while the worker's replay buffer is
 * bounded (WORKER_REPLAY_BUFFER_LIMIT) and drops frames when a host stays
 * unreachable for long enough. Without this the two would deadlock, the
 * watermark stuck below the hole forever and the buffer growing without
 * bound behind it.
 *
 * `throughSeq` is the highest sequence number the worker no longer holds
 * anything at or below, so it is only ever sent once every frame under it has
 * been either acknowledged or dropped. The host treats the whole range as
 * accounted for, advances past it, and logs the loss against the run: a few
 * missing console lines are visible and survivable, a stalled run is not.
 */
export const leaseGapMessageSchema = z.object({
  type: z.literal("lease-gap"),
  leaseId: z.string(),
  runId: z.string(),
  throughSeq: z.number().int().nonnegative(),
  /** How many frames were actually dropped in that range, for the host's log line. */
  dropped: z.number().int().nonnegative(),
});
export type LeaseGapMessage = z.infer<typeof leaseGapMessageSchema>;

// --- Interactive attach ----------------------------------------------------
//
// A finished run's retained sandbox lives on the worker that executed it, so
// The desktop terminal cannot reach it directly.
// The worker runs the PTY inside the retained bwrap sandbox and the host
// relays its bytes between that PTY and the browser or CLI socket. Terminal
// bytes travel as UTF-8 strings, exactly as they already do on the
// dashboard's attach socket.

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

/** One calendar day of ccusage-reported usage, mirroring UsageDay in usage.ts. */
export const usageDaySchema = z.object({
  date: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  costUsd: z.number(),
});

/**
 * The worker's answer to a usage-report request: the machine's daily usage
 * as ccusage sees it, or why the read produced nothing.
 */
export const usageReportResultMessageSchema = z.object({
  type: z.literal("usage-report-result"),
  requestId: z.string(),
  days: z.array(usageDaySchema),
  error: z.string().optional(),
});
export type UsageReportResultMessage = z.infer<typeof usageReportResultMessageSchema>;

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
  leaseGapMessageSchema,
  attachDataMessageSchema,
  attachExitMessageSchema,
  attachErrorMessageSchema,
  usageReportResultMessageSchema,
]);
export type WorkerMessage = z.infer<typeof workerMessageSchema>;

// --- Host -> worker messages -----------------------------------------------

export const registeredMessageSchema = z.object({
  type: z.literal("registered"),
  protocolVersion: z.number(),
  heartbeatIntervalMs: z.number(),
  hostVersion: z.string(),
  /** The id the host enrolled this worker under; it is the host's to assign, not the worker's to pick. */
  workerId: z.string(),
  /** The name the fleet shows for this worker, which a rename on the dashboard can have changed. */
  name: z.string(),
  state: workerStateSchema,
  /**
   * Present only on the connection that redeemed a pairing token: the durable
   * secret the worker stores and authenticates with from then on. Every later
   * registration answers without it, since the worker already has one.
   */
  credential: z.string().optional(),
});
export type RegisteredMessage = z.infer<typeof registeredMessageSchema>;

/** Why the host refused a registration. */
export const workerDenyReasonSchema = z.enum([
  "invalid-token",
  "expired-token",
  "unauthorized",
  "protocol",
  "malformed",
]);
export type WorkerDenyReason = z.infer<typeof workerDenyReasonSchema>;

export const rejectedMessageSchema = z.object({
  type: z.literal("rejected"),
  /**
   * What kind of refusal this is, so the worker can tell a token worth
   * falling back from ("invalid-token") apart from an enrollment that is gone
   * for good ("unauthorized"), without parsing prose.
   */
  code: workerDenyReasonSchema,
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
   * key). The worker applies its own local sandbox concurrency and timeout
   * rather than trusting the host's copy.
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

/**
 * How far the host has got through one lease's reporting stream. Sent right
 * after `registered` for every lease a reconnecting worker still claims (so
 * it knows what to replay before it sends anything newer), and again on every
 * heartbeat (so a long-running lease's replay buffer keeps getting trimmed).
 * `seq` is the highest sequence number the host has applied for the lease,
 * with every sequence below it applied too; 0 means it has applied nothing
 * yet. It never runs ahead of a gap, so a repeat of the same number is the
 * worker's cue that something it sent did not land.
 */
export const leaseAckMessageSchema = z.object({
  type: z.literal("lease-ack"),
  leaseId: z.string(),
  runId: z.string(),
  seq: z.number().int().nonnegative(),
  /**
   * The lease's deadline as the host currently holds it, which is what makes
   * this frame a renewal and not just an acknowledgement. The worker keeps
   * its own copy and stops the run itself once it passes with no further
   * contact: see `leaseLostMessageSchema` for why a run must never outlive
   * its lease.
   */
  expiresAt: z.string(),
});
export type LeaseAckMessage = z.infer<typeof leaseAckMessageSchema>;

/**
 * The host no longer holds this lease, so whatever the worker is still doing
 * for it must stop. The fence around a re-dispatched run: once a lease
 * expires the host is free to hand that run to another worker, and two
 * workers pushing the same deterministic branch at once is exactly what this
 * exists to prevent.
 *
 * Sent on registration for every lease a reconnecting worker still claims
 * that the host has no record of, which covers the partitioned worker that
 * comes back. The worker aborts the run, drops the claim and drops the
 * lease's replay buffer without reporting anything: the host has moved on,
 * and nothing it sends for that lease would be accepted anyway. The other
 * half of the fence is worker-side, since a worker that never reconnects
 * gets no frame at all: it enforces `expiresAt` locally (see
 * `leaseAckMessageSchema`).
 */
export const leaseLostMessageSchema = z.object({
  type: z.literal("lease-lost"),
  leaseId: z.string(),
  runId: z.string(),
  reason: z.string(),
});
export type LeaseLostMessage = z.infer<typeof leaseLostMessageSchema>;

export const discardMessageSchema = z.object({
  type: z.literal("discard"),
  /** Drop a retained sandbox disk the worker still holds, e.g. its retention window ended or the run was retried. */
  runId: z.string(),
});
export type DiscardMessage = z.infer<typeof discardMessageSchema>;

export const heartbeatAckMessageSchema = z.object({
  type: z.literal("heartbeat-ack"),
  ts: z.string(),
  /** The operator-controlled state, echoed on every ack so a drain reaches a worker that missed the push below. */
  state: workerStateSchema,
});
export type HeartbeatAckMessage = z.infer<typeof heartbeatAckMessageSchema>;

/**
 * The operator changed this worker's state on the Workers page. Pushed as it
 * happens so a drain takes effect immediately rather than at the worker's next
 * heartbeat; "draining" means finish the leases already held and accept
 * nothing new.
 */
export const workerStateMessageSchema = z.object({
  type: z.literal("worker-state"),
  state: workerStateSchema,
});
export type WorkerStateMessage = z.infer<typeof workerStateMessageSchema>;

/**
 * The enrollment behind this connection was revoked. The worker deletes its
 * stored credential and stops: reconnecting with it is refused, so retrying
 * would only produce a rejection loop.
 */
export const revokedMessageSchema = z.object({
  type: z.literal("revoked"),
  reason: z.string(),
});
export type RevokedMessage = z.infer<typeof revokedMessageSchema>;

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

/**
 * Ask the worker for its machine's daily usage (ccusage's daily report).
 * Answered with usage-report-result carrying the same requestId.
 */
export const usageReportMessageSchema = z.object({
  type: z.literal("usage-report"),
  requestId: z.string(),
});
export type UsageReportMessage = z.infer<typeof usageReportMessageSchema>;

export const hostMessageSchema = z.discriminatedUnion("type", [
  registeredMessageSchema,
  rejectedMessageSchema,
  dispatchMessageSchema,
  cancelMessageSchema,
  runCompleteAckMessageSchema,
  leaseAckMessageSchema,
  leaseLostMessageSchema,
  discardMessageSchema,
  heartbeatAckMessageSchema,
  workerStateMessageSchema,
  revokedMessageSchema,
  attachOpenMessageSchema,
  attachInputMessageSchema,
  attachResizeMessageSchema,
  attachCloseMessageSchema,
  usageReportMessageSchema,
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
