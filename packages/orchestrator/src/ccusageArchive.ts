import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CCUSAGE_DIR } from "@brevi/shared";
import { isSafePathSegment, resolveWithin } from "./safepath.js";

/**
 * Host-side usage accounting archive: minimized Claude session snapshots
 * reported by workers (run-usage-snapshot frames), stored in the layout
 * ccusage reads through CLAUDE_CONFIG_DIR:
 *
 *   ~/.brevi/ccusage/claude/projects/<project-key>/<session-id>.jsonl
 *
 * Kept apart from ~/.claude, runs/, and workspaces/ on purpose: deleting run
 * artifacts or reaping retained sandboxes must never delete accounting.
 * Retention is indefinite by design; snapshots only replace or add session
 * files, and reclaiming space is an explicit operator action (delete
 * ~/.brevi/ccusage), never a side effect of run cleanup.
 */
export class CcusageArchive {
  readonly #dir: string;
  /** All writes chain here so two snapshots for one session can never interleave their temp/rename pairs. */
  #io: Promise<void> = Promise.resolve();

  constructor(dir: string = CCUSAGE_DIR) {
    this.#dir = dir;
  }

  /** Where the archive lives, for callers that print or document it. */
  get dir(): string {
    return this.#dir;
  }

  /**
   * Absolute path of one session's archive file, or null when either
   * worker-supplied segment is unusable. A leading dot is refused on top of
   * the segment check: it could hide the file from a listing or collide with
   * a ccusage config name, and no legitimate project key or session id
   * starts with one.
   */
  pathFor(source: "claude", projectKey: string, sessionId: string): string | null {
    if (!isSafePathSegment(projectKey) || !isSafePathSegment(sessionId)) return null;
    if (projectKey.startsWith(".") || sessionId.startsWith(".")) return null;
    return resolveWithin(this.#dir, source, "projects", projectKey, `${sessionId}.jsonl`);
  }

  /**
   * Atomically replace one session's snapshot: written to a sibling temp
   * file and renamed into place (same idiom as config.ts). Replacement,
   * never append, is what keeps replayed frames and re-exported grown
   * sessions from double-counting usage. Throws on an unsafe path or a
   * filesystem failure; the caller decides whether that drops the frame or
   * stalls its lease's watermark for a retry.
   */
  async save(source: "claude", projectKey: string, sessionId: string, jsonl: string): Promise<void> {
    const path = this.pathFor(source, projectKey, sessionId);
    if (!path) {
      throw new Error(`unsafe ccusage archive path: ${JSON.stringify(projectKey)}/${JSON.stringify(sessionId)}`);
    }
    const next = this.#io.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        await writeFile(temp, jsonl, "utf8");
        await rename(temp, path);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    this.#io = next.catch(() => undefined);
    return next;
  }
}
