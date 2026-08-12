import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BREVI_HOME } from "@brevi/shared";

/**
 * Settings for the managed macOS worker VM, kept in `~/.brevi/mac-vm.json`.
 *
 * This is deliberately not part of `~/.brevi/config.json`'s zod schema. That
 * schema is mirrored into the dashboard's settings forms and the docs config
 * table, and it is shared with every other platform; a macOS-only VM section
 * (instance sizing, the Lima instance name, the guest's enrollment) would be
 * noise there for the vast majority of hosts that never run a mac worker.
 * Keeping it as its own file also means it can be forgotten (uninstalled)
 * independently of the rest of the user's config.
 */

export const MAC_VM_STATE_PATH = join(BREVI_HOME, "mac-vm.json");
export const DEFAULT_MAC_VM_NAME = "brevi";

export interface MacVmSettings {
  /** Lima instance name. */
  name: string;
  cpus: number;
  memoryGiB: number;
  diskGiB: number;
  /** Minutes with no leased run, no attach session and no queued host work before the VM stops. 0 disables the idle stop. */
  idleStopMinutes: number;
  /** Seconds between host demand polls. */
  pollSeconds: number;
  /** Host the guest worker dials, e.g. "http://192.168.1.10:4400". */
  hostUrl: string;
  /** Single-use pairing token the guest enrolls with; cleared once the guest has redeemed it. */
  token: string;
  /** Name this worker shows under on the host's dashboard. */
  workerName: string;
  /** Worker id the host assigned the guest, read off it after enrollment; empty until then. */
  workerId: string;
  /**
   * The guest's durable per-worker credential, copied off it alongside
   * `workerId`. The supervisor runs out here on macOS rather than in the
   * guest, so polling the host for demand (which it has to do while the guest
   * is stopped) needs its own copy of what authenticates as that worker.
   */
  credential: string;
  /**
   * Whether the drain currently recorded on the host is this supervisor's own,
   * placed to reserve the machine for shutdown (see `mayStopAfterReservation`).
   * Persisted rather than kept in memory because a supervisor restarted
   * between the drain and the release must still know the drain is its own to
   * undo; an operator's drain, by contrast, has to survive untouched.
   */
  selfDrained: boolean;
  /** How many dispatched runs the guest executes at once. */
  concurrency: number;
}

const DEFAULTS: MacVmSettings = {
  name: DEFAULT_MAC_VM_NAME,
  cpus: 4,
  memoryGiB: 8,
  diskGiB: 100,
  idleStopMinutes: 20,
  pollSeconds: 20,
  hostUrl: "",
  token: "",
  workerName: "",
  workerId: "",
  credential: "",
  selfDrained: false,
  concurrency: 1,
};

/**
 * Inclusive clamp ranges for every numeric field, so a hand-edited file can
 * never hand the installer an impossible VM. `concurrency`'s upper bound is
 * deliberately narrower than `@brevi/shared`'s WORKER_MAX_CONCURRENCY (64):
 * that constant caps the wire protocol for every worker kind, while one
 * managed macOS VM realistically has far less headroom, so it does not fit
 * here and is not reused.
 */
const RANGES: Record<
  "cpus" | "memoryGiB" | "diskGiB" | "idleStopMinutes" | "pollSeconds" | "concurrency",
  { min: number; max: number }
> = {
  cpus: { min: 1, max: 64 },
  memoryGiB: { min: 4, max: 512 },
  diskGiB: { min: 20, max: 2000 },
  idleStopMinutes: { min: 0, max: 1440 },
  pollSeconds: { min: 5, max: 600 },
  concurrency: { min: 1, max: 16 },
};

/** A finite number within [min, max]; the default when raw is not a usable number. */
function clampedNumber(raw: unknown, fallback: number, range: { min: number; max: number }): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.min(range.max, Math.max(range.min, raw));
}

function stringOr(raw: unknown, fallback: string): string {
  return typeof raw === "string" ? raw : fallback;
}

function booleanOr(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

/** Defaults plus clamping, so a hand-edited file can never hand the installer an impossible VM. */
export function normalizeMacVmSettings(
  raw: unknown,
  overrides: Partial<MacVmSettings> = {},
): MacVmSettings {
  const source = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};

  const pick = <K extends keyof MacVmSettings>(key: K): MacVmSettings[K] =>
    overrides[key] !== undefined ? (overrides[key] as MacVmSettings[K]) : (source[key] as MacVmSettings[K]);

  return {
    name: stringOr(pick("name"), DEFAULTS.name),
    cpus: clampedNumber(pick("cpus"), DEFAULTS.cpus, RANGES.cpus),
    memoryGiB: clampedNumber(pick("memoryGiB"), DEFAULTS.memoryGiB, RANGES.memoryGiB),
    diskGiB: clampedNumber(pick("diskGiB"), DEFAULTS.diskGiB, RANGES.diskGiB),
    idleStopMinutes: clampedNumber(pick("idleStopMinutes"), DEFAULTS.idleStopMinutes, RANGES.idleStopMinutes),
    pollSeconds: clampedNumber(pick("pollSeconds"), DEFAULTS.pollSeconds, RANGES.pollSeconds),
    hostUrl: stringOr(pick("hostUrl"), DEFAULTS.hostUrl),
    token: stringOr(pick("token"), DEFAULTS.token),
    workerName: stringOr(pick("workerName"), DEFAULTS.workerName),
    workerId: stringOr(pick("workerId"), DEFAULTS.workerId),
    credential: stringOr(pick("credential"), DEFAULTS.credential),
    selfDrained: booleanOr(pick("selfDrained"), DEFAULTS.selfDrained),
    concurrency: clampedNumber(pick("concurrency"), DEFAULTS.concurrency, RANGES.concurrency),
  };
}

/** Resolves to undefined when the file is absent or unreadable (missing, malformed JSON, ...). */
export async function loadMacVmSettings(path: string = MAC_VM_STATE_PATH): Promise<MacVmSettings | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    return normalizeMacVmSettings(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/**
 * Atomic write (temp file + rename), mode 0600, mirroring `saveEnrollment` in
 * @brevi/worker's identity.ts. This is the only copy of the guest's credential
 * and of the shutdown reservation marker, and it is written at the worst
 * possible moment: right before the machine is powered off. A truncated file
 * reads as no file at all, which would leave the supervisor with no worker
 * identity and a `KeepAlive` launchd agent looping on a VM it can no longer
 * ask about. A rename cannot half-happen, so there is no such state to land in.
 *
 * The rename also replaces the inode, so 0600 is the mode the file actually
 * ends up with even when an older, world-readable one was there first: it
 * holds a credential, and whatever the process umask would produce is not
 * good enough for it.
 */
export async function saveMacVmSettings(
  settings: MacVmSettings,
  path: string = MAC_VM_STATE_PATH,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, path);
  } catch (error) {
    // Never leave a credential-bearing temp file behind on a failed save.
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Removes the state file, tolerating its absence. */
export async function forgetMacVmSettings(path: string = MAC_VM_STATE_PATH): Promise<void> {
  await rm(path, { force: true });
}
