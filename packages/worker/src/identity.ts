import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { WORKER_ID_PATH } from "@brevi/shared";

/**
 * A stable id for this machine, so a reconnect (a restart, a dropped socket)
 * is recognised by the host as the same worker rather than a new one:
 * created once at `~/.brevi/worker-id` and read back on every later start.
 * Independent of the pairing token, which authenticates the worker but
 * carries no identity of its own (several workers can share one token).
 */
export async function workerId(path: string = WORKER_ID_PATH): Promise<string> {
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing) return existing;
  } catch {
    // No id yet; create one below.
  }
  const id = randomUUID();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${id}\n`);
  return id;
}
