import { createHash } from "node:crypto";
import { join } from "node:path";
import { WORKER_MAX_USAGE_SNAPSHOT_BYTES } from "@brevi/shared";
import { readdirWithin, readFileWithin } from "@brevi/sandbox";
import { isSafePathSegment } from "@brevi/orchestrator/internal";

/**
 * Post-execution export of usage-only Claude session snapshots (PD-74): find
 * the session's transcript under the sandbox home, reduce it to the fields
 * ccusage needs for accounting, and hand the result to the host, which
 * archives it under ~/.brevi/ccusage. Everything here is best effort by
 * contract: a missing or malformed transcript logs a diagnostic and produces
 * nothing, never a failed run.
 */

/** Claude data roots (relative to a sandbox home) whose projects/ tree may hold session transcripts. */
const CLAUDE_DATA_ROOTS = [".claude", join(".config", "claude")];

/**
 * Largest raw transcript worth reading before minimizing. Transcripts carry
 * full tool traffic and can grow large on long sessions; anything past this
 * is pathological and gets a diagnostic instead of a giant read.
 */
const MAX_RAW_TRANSCRIPT_BYTES = 256 * 1024 * 1024;

/** One session's sanitized snapshot, ready to travel as a run-usage-snapshot frame. */
export interface UsageSnapshot {
  source: "claude";
  projectKey: string;
  sessionId: string;
  /**
   * Set when this snapshot came from a subagent transcript rather than the
   * main session file: the stem of the subagent's jsonl file name (Claude
   * writes it as `projects/<dir>/<sessionId>/subagents/<subagentId>.jsonl`).
   * Absent for a main-session snapshot, so existing consumers see no change.
   */
  subagentId?: string;
  jsonl: string;
  contentHash: string;
}

function isDict(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Stable archive directory name for a run's usage snapshots: the repo key
 * ("owner/name") reduced to one safe path segment. Never derived from a
 * filesystem path, so worker disk layout stays out of the host archive.
 */
export function projectKeyFor(repo: string | undefined): string {
  const slug = (repo ?? "")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/-+$/, "");
  return `brevi-${slug || "unknown"}`.slice(0, 100);
}

/** The token fields ccusage reads from a transcript line's message.usage. */
const USAGE_TOKEN_FIELDS = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"] as const;

/**
 * Reduce one Claude session transcript to a ccusage-compatible, usage-only
 * JSONL. Only lines carrying token usage survive, and each survivor is
 * rebuilt from an allowlist (event type, timestamp, session/request/message
 * ids, model, the four token counts, any pre-calculated cost), so prompt and
 * response content, thinking, tool traffic, environment values, and paths
 * can never leak into the archive by omission of a filter.
 */
export function minimizeClaudeSessionJsonl(raw: string, sessionId: string): { jsonl: string; kept: number; malformed: number } {
  const out: string[] = [];
  let malformed = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      malformed += 1;
      continue;
    }
    if (!isDict(event)) continue;
    const message = isDict(event.message) ? event.message : undefined;
    const usage = message && isDict(message.usage) ? message.usage : undefined;
    // Lines without token usage (user prompts, tool results, summaries) are
    // exactly the ones ccusage ignores and privacy forbids; skip them whole.
    if (!message || !usage || typeof event.timestamp !== "string") continue;
    if (typeof usage.input_tokens !== "number" || typeof usage.output_tokens !== "number") continue;
    const keptUsage: Record<string, number> = {};
    for (const field of USAGE_TOKEN_FIELDS) {
      const value = usage[field];
      if (typeof value === "number") keptUsage[field] = value;
    }
    const keptMessage: Record<string, unknown> = { usage: keptUsage };
    if (typeof message.id === "string") keptMessage.id = message.id;
    if (typeof message.model === "string") keptMessage.model = message.model;
    const kept: Record<string, unknown> = {
      type: typeof event.type === "string" ? event.type : "assistant",
      timestamp: event.timestamp,
      sessionId: typeof event.sessionId === "string" ? event.sessionId : sessionId,
      message: keptMessage,
    };
    if (typeof event.requestId === "string") kept.requestId = event.requestId;
    if (typeof event.version === "string") kept.version = event.version;
    if (typeof event.costUSD === "number") kept.costUSD = event.costUSD;
    if (typeof event.isApiErrorMessage === "boolean") kept.isApiErrorMessage = event.isApiErrorMessage;
    out.push(JSON.stringify(kept));
  }
  return { jsonl: out.length > 0 ? `${out.join("\n")}\n` : "", kept: out.length, malformed };
}

/** One discovered transcript file: a main session's own file, or one of its subagents'. */
interface TranscriptRecord {
  sessionId: string;
  subagentId?: string;
  path: string;
}

/**
 * Every session transcript under the home's Claude data roots, optionally
 * narrowed to one session id. Claude mangles the cwd into the project
 * directory's name, which is undocumented and version-dependent, so the tree
 * is scanned rather than the name computed. First root wins on a duplicate
 * identity (a main session's own id, or `sessionId/subagentId` for a
 * subagent transcript).
 *
 * Alongside each project directory's top-level `<sessionId>.jsonl` files,
 * Claude also nests subagent transcripts one level deeper, at
 * `<sessionId>/subagents/<subagentId>.jsonl`; both shapes are scanned so a
 * run's exported usage snapshot never misses tokens burned by a subagent.
 */
async function findSessionTranscripts(homePath: string, sessionId?: string): Promise<TranscriptRecord[]> {
  const found = new Map<string, TranscriptRecord>();
  for (const root of CLAUDE_DATA_ROOTS) {
    const projectsDir = join(homePath, root, "projects");
    // Every directory level sits in the agent-writable tree, so each is
    // enumerated through the sandbox package's no-follow traversal: a
    // component swapped for a symlink fails the listing instead of pointing
    // the scan at an arbitrary host directory.
    let projectDirs: string[];
    try {
      projectDirs = await readdirWithin(homePath, projectsDir);
    } catch {
      continue;
    }
    for (const dir of projectDirs) {
      if (!isSafePathSegment(dir)) continue;
      let entries: string[];
      try {
        entries = await readdirWithin(homePath, join(projectsDir, dir));
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!isSafePathSegment(entry)) continue;
        if (entry.endsWith(".jsonl")) {
          // A main session's own transcript.
          const id = entry.slice(0, -".jsonl".length);
          if (id.length === 0 || (sessionId !== undefined && id !== sessionId)) continue;
          if (!found.has(id)) found.set(id, { sessionId: id, path: join(projectsDir, dir, entry) });
          continue;
        }
        // Otherwise `entry` may be a session directory holding subagent
        // transcripts; a plain file or a missing/non-directory `subagents`
        // throws ENOTDIR/ENOENT from the traversal, which is simply skipped,
        // same idiom as the listings above.
        if (sessionId !== undefined && entry !== sessionId) continue;
        let subagentFiles: string[];
        try {
          subagentFiles = await readdirWithin(homePath, join(projectsDir, dir, entry, "subagents"));
        } catch {
          continue;
        }
        for (const subagentFile of subagentFiles) {
          if (!subagentFile.endsWith(".jsonl") || !isSafePathSegment(subagentFile)) continue;
          const subagentId = subagentFile.slice(0, -".jsonl".length);
          if (subagentId.length === 0) continue;
          const identity = `${entry}/${subagentId}`;
          if (!found.has(identity)) {
            found.set(identity, { sessionId: entry, subagentId, path: join(projectsDir, dir, entry, "subagents", subagentFile) });
          }
        }
      }
    }
  }
  return [...found.values()];
}

export interface CollectUsageSnapshotsOptions {
  /** Sandbox home whose Claude data roots are scanned; a real directory on this worker's disk. */
  homePath: string;
  projectKey: string;
  /** Restrict to one captured session id; absent exports every session in the home (the attach re-export). */
  sessionId?: string;
  /** Diagnostic sink; failures are reported here, never thrown past the caller's catch. */
  log: (text: string) => void;
}

/**
 * Locate, sanitize, and bound the home's Claude session transcripts. A
 * transcript that is missing, unreadable, oversized, or usage-free yields no
 * snapshot and a diagnostic; whatever else is usable is still returned.
 */
export async function collectUsageSnapshots(options: CollectUsageSnapshotsOptions): Promise<UsageSnapshot[]> {
  const { homePath, projectKey, sessionId, log } = options;
  const transcripts = await findSessionTranscripts(homePath, sessionId);
  if (transcripts.length === 0) {
    if (sessionId !== undefined) log(`usage snapshot: no transcript found for session ${sessionId}`);
    return [];
  }
  const snapshots: UsageSnapshot[] = [];
  for (const transcript of transcripts) {
    // Identifies this transcript in diagnostics: a subagent's is qualified
    // with its parent session so a read failure or malformed line can be
    // traced back to the right transcript file.
    const label = transcript.subagentId !== undefined ? `session ${transcript.sessionId} subagent ${transcript.subagentId}` : `session ${transcript.sessionId}`;
    let raw: string;
    try {
      // The transcript sits in an agent-writable tree, and another process
      // (a second attach session, say) can mutate it between any check and
      // the read, so the read itself is the defense: a descriptor-based
      // no-follow traversal a racing symlink swap cannot redirect out of the
      // sandbox home, with the size cap enforced on the opened descriptor
      // and the read bounded to it.
      raw = await readFileWithin(homePath, transcript.path, MAX_RAW_TRANSCRIPT_BYTES);
    } catch (error) {
      log(`usage snapshot: could not read ${label}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const minimized = minimizeClaudeSessionJsonl(raw, transcript.sessionId);
    if (minimized.malformed > 0) {
      log(`usage snapshot: skipped ${minimized.malformed} malformed transcript line(s) for ${label}`);
    }
    if (minimized.kept === 0) continue;
    if (Buffer.byteLength(minimized.jsonl, "utf8") > WORKER_MAX_USAGE_SNAPSHOT_BYTES) {
      log(`usage snapshot: ${label} minimizes to over the ${WORKER_MAX_USAGE_SNAPSHOT_BYTES}-byte transfer limit; skipped`);
      continue;
    }
    snapshots.push({
      source: "claude",
      projectKey,
      sessionId: transcript.sessionId,
      ...(transcript.subagentId !== undefined ? { subagentId: transcript.subagentId } : {}),
      jsonl: minimized.jsonl,
      contentHash: createHash("sha256").update(minimized.jsonl).digest("hex"),
    });
  }
  return snapshots;
}
