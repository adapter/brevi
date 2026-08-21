import { atomicWriteFile, CCUSAGE_DIR, isSafePathSegment, resolveWithin, WriteQueue } from "@brevi/shared";

/**
 * Host-side usage accounting archive: minimized Claude session snapshots
 * reported by workers (run-usage-snapshot frames), stored in the layout
 * ccusage reads through CLAUDE_CONFIG_DIR:
 *
 *   ~/.brevi/ccusage/claude/projects/<project-key>/<session-id>.jsonl
 *
 * A subagent's transcript is a snapshot in its own right, mirroring Claude
 * Code's own on-disk layout so ccusage descends into it the same way it does
 * for a real session directory:
 *
 *   ~/.brevi/ccusage/claude/projects/<project-key>/<session-id>/subagents/<subagent-id>.jsonl
 *
 * A file named `<session-id>.jsonl` and a directory named `<session-id>`
 * legitimately coexist under one project key: ccusage reads both.
 *
 * Kept apart from ~/.claude, runs/, and workspaces/ on purpose: deleting run
 * artifacts or reaping retained sandboxes must never delete accounting.
 * Retention is indefinite by design; snapshots only replace or add session
 * files, and reclaiming space is an explicit operator action (delete
 * ~/.brevi/ccusage), never a side effect of run cleanup.
 */
export class CcusageArchive {
  readonly #dir: string;
  /** All writes chain here so two snapshots for one session can never interleave their temp/rename pairs. Unlabeled: the caller owns error reporting. */
  #io = new WriteQueue();

  constructor(dir: string = CCUSAGE_DIR) {
    this.#dir = dir;
  }

  /** Where the archive lives, for callers that print or document it. */
  get dir(): string {
    return this.#dir;
  }

  /**
   * Absolute path of one session's archive file, or the nested path of one
   * of its subagents' archive files when `subagentId` is given, or null when
   * any worker-supplied segment is unusable. A leading dot is refused on top
   * of the segment check: it could hide the file from a listing or collide
   * with a ccusage config name, and no legitimate project key, session id,
   * or subagent id starts with one. `sessionId` becomes a directory name in
   * the subagent layout, so its validation matters just as much there as it
   * does for the file it names when `subagentId` is absent.
   */
  pathFor(
    source: "claude",
    projectKey: string,
    sessionId: string,
    subagentId?: string,
  ): string | null {
    if (!isSafePathSegment(projectKey) || !isSafePathSegment(sessionId)) return null;
    if (projectKey.startsWith(".") || sessionId.startsWith(".")) return null;
    if (subagentId === undefined) {
      return resolveWithin(this.#dir, source, "projects", projectKey, `${sessionId}.jsonl`);
    }
    if (!isSafePathSegment(subagentId) || subagentId.startsWith(".")) return null;
    return resolveWithin(
      this.#dir,
      source,
      "projects",
      projectKey,
      sessionId,
      "subagents",
      `${subagentId}.jsonl`,
    );
  }

  /**
   * Atomically replace one session's snapshot, or one subagent's snapshot
   * when `subagentId` is given (see atomicWriteFile). Replacement, never
   * append, is what keeps replayed frames and re-exported grown sessions or
   * subagent transcripts from double-counting usage. Throws on an unsafe path or a
   * filesystem failure; the caller decides whether that drops the frame or
   * stalls its lease's watermark for a retry.
   */
  async save(
    source: "claude",
    projectKey: string,
    sessionId: string,
    jsonl: string,
    subagentId?: string,
  ): Promise<void> {
    const path = this.pathFor(source, projectKey, sessionId, subagentId);
    if (!path) {
      throw new Error(
        `unsafe ccusage archive path: ${JSON.stringify(projectKey)}/${JSON.stringify(sessionId)}` +
          (subagentId === undefined ? "" : `/subagents/${JSON.stringify(subagentId)}`),
      );
    }
    return this.#io.enqueue(() => atomicWriteFile(path, jsonl));
  }
}
