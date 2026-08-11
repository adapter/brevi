import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { WORKER_STATE_PATH } from "@brevi/shared";

/**
 * This machine's enrollment with a brevi host, kept at `~/.brevi/worker.json`.
 *
 * A worker does not invent its own identity: the id below is the HOST's to
 * assign, and it arrives in the `registered` frame answering the connection
 * that redeemed a pairing token. The token itself is single-use and worth
 * nothing afterwards; what it buys is the durable credential recorded here,
 * and that credential is what authenticates every later connect (a restart, a
 * reconnect after a drop), so the host recognises the same worker rather than
 * enrolling a new one. It is the only fleet secret that ever touches worker
 * disk, hence mode 0600. Losing this file costs nothing but a fresh pairing
 * token.
 */
export interface WorkerEnrollment {
  workerId: string;
  credential: string;
  /**
   * The host that issued the credential. A machine re-pointed at a different
   * brevi instance must not present a credential that instance never issued,
   * so the record only applies to the `--host` it was earned from.
   */
  host: string;
}

function isEnrollment(value: unknown): value is WorkerEnrollment {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.workerId === "string" &&
    record.workerId.length > 0 &&
    typeof record.credential === "string" &&
    record.credential.length > 0 &&
    typeof record.host === "string" &&
    record.host.length > 0
  );
}

/** Compares two host urls by origin, so `http://host:4400/` and `http://host:4400` are the same host; a value that is not a url at all falls back to an exact match. */
function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return a === b;
  }
}

/**
 * The stored enrollment, or undefined when there is none. Absent (this
 * machine has never enrolled), unreadable, and malformed all collapse to the
 * same answer on purpose: every one of them means there is no credential to
 * connect with, and the only cure for any of them is a pairing token.
 */
export async function readEnrollment(path: string = WORKER_STATE_PATH): Promise<WorkerEnrollment | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isEnrollment(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The stored enrollment, but only when `hostUrl` is the host that issued it; a credential from another host would just be refused, so it counts as no credential at all. */
export async function enrollmentFor(hostUrl: string, path?: string): Promise<WorkerEnrollment | undefined> {
  const record = await readEnrollment(path);
  if (!record) return undefined;
  return sameHost(record.host, hostUrl) ? record : undefined;
}

/**
 * Atomic write (temp file + rename), mode 0600, mirroring saveConfig on the
 * host side. The rename replaces the inode, so 0600 is the mode the file
 * actually ends up with even when an older, world-readable one was there
 * first: this holds a credential, and whatever the process umask would
 * produce is not good enough for it.
 */
export async function saveEnrollment(record: WorkerEnrollment, path: string = WORKER_STATE_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, path);
  } catch (error) {
    // Never leave a credential-bearing temp file behind on a failed save.
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Forgets this machine's enrollment, after the host revoked it or refused the credential outright: keeping a dead credential around only produces a rejection loop on every later start. */
export async function clearEnrollment(path: string = WORKER_STATE_PATH): Promise<void> {
  await rm(path, { force: true });
}
