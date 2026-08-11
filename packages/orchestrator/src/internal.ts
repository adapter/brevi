/**
 * Node-side building blocks that `@brevi/worker` reuses: GitHub, Linear, R2,
 * and usage-limit/memory helpers the host also uses. These pieces don't
 * belong to any one execution engine, so duplicating them into the worker
 * package would just be two copies to keep in sync; a one-way dependency is
 * cheaper. The dependency runs one way only: the orchestrator never imports
 * `@brevi/worker` or `@brevi/sandbox` (see the "@brevi/sandbox" grep check in
 * this repo's CI, which enforces the sandbox half of that split).
 *
 * Nothing here is scheduling state (RunStore, MemoryStore, the Orchestrator
 * class itself): those stay host-only, mirrored to a worker over the wire
 * protocol in `@brevi/shared`'s worker.ts instead of shared by import.
 */

export {
  authenticatedRemote,
  createPullRequest,
  FALLBACK_COMMIT_IDENTITY,
  formatPrFeedback,
  gatherPrFeedback,
  hasActionableFeedback,
  markPullRequestReady,
  parsePrUrl,
  plainRemote,
  postPrComment,
  resolveCommitIdentity,
  type PrFeedback,
} from "./github.js";

export { AgentLimitError, agentProvider, detectLimit, isAgentFailureEvent, resumeTimeFor } from "./limits.js";

export { LinearService, type LinearAuthHooks } from "./linear.js";

export { memoryKeyFor, readRunMemories } from "./memory.js";

export { uploadRunEvidence, type UploadedEvidence } from "./r2.js";

export { isContainedRegularFile, isSafePathSegment, resolveWithin } from "./safepath.js";

export { lineSink, raceWithAbort, RunCancelledError, throwIfAborted } from "./util.js";

export { isTerminal } from "./state.js";
