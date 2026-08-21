import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Serializes async file writes through one promise chain so writes from one
 * store can never interleave on disk. The chain itself always recovers: one
 * failed write never wedges the writes queued behind it. Only the promise
 * `enqueue` returns rejects, so callers that need durability can await it
 * while fire-and-forget callers stay fire-and-forget.
 */
export class WriteQueue {
  /** Log prefix for failed writes, e.g. "run store"; without one the chain swallows silently and the caller owns reporting. */
  readonly #label?: string;
  #tail: Promise<void> = Promise.resolve();

  constructor(label?: string) {
    this.#label = label;
  }

  /** Append one write; the returned promise settles with that write alone. */
  enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.#tail.then(task, task);
    this.#tail = next.catch((error: unknown) => {
      if (this.#label === undefined) return;
      console.error(
        `[brevi] ${this.#label} write failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return next;
  }

  /** Wait for all writes queued so far to land. */
  async flush(): Promise<void> {
    await this.#tail;
  }
}

/**
 * Atomic replace: write to a sibling temp file, then rename into place, so a
 * crash (or a reader arriving mid-write) never sees a truncated file; the old
 * file stays intact until the new one is complete. The temp name is random,
 * not pid-based: two processes pointed at one file would otherwise collide
 * only when they share a pid, but a retry after a crash can, and clobbering a
 * live temp file publishes the other writer's bytes. `mode` applies to the
 * temp file and, through the rename, becomes the destination's mode; pass
 * 0o600 for files holding secrets. A failed write removes the temp file so
 * secret-bearing bytes are never left behind.
 */
export async function atomicWriteFile(
  path: string,
  text: string,
  options: { mode?: number } = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, text, options.mode === undefined ? {} : { mode: options.mode });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** atomicWriteFile of a value serialized as pretty-printed JSON plus a trailing newline. */
export function atomicWriteJson(
  path: string,
  value: unknown,
  options: { mode?: number } = {},
): Promise<void> {
  return atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`, options);
}
