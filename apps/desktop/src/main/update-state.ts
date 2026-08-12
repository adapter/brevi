// Node `fs` only, no `electron`, so this stays testable under plain bun
// (see the note at the top of summary.ts).
//
// Bookkeeping for the desktop app's auto-updater, persisted at
// ~/.brevi/desktop-update.json. This is the ONLY file under ~/.brevi the
// desktop updater ever writes: config.json and the run history live in the
// orchestrator, and their schemas and migrations are owned there, not here.
// Keeping the updater's state in its own file means a bug in this code can
// never corrupt or race with anything the orchestrator reads or writes.
//
// The rollback story this module exists to support: electron-updater applies
// an update by downloading a new build and, on a successful install, having
// the OS swap it in for the one that's running. If the install fails partway
// (a bad download, a permissions problem, the AppImage getting replaced by
// something that won't launch), the OLD app is simply still the one that
// starts back up, nothing else has to undo anything. So "did the install
// work?" is answered after the fact, on the next launch, by comparing the
// version we asked to install (`pending.version`) against the version that's
// actually running (`reconcile`'s `runningVersion`). A mismatch means the
// install didn't take. Repeated failures for the same version are counted
// (`attempts`) and once a version fails MAX_INSTALL_ATTEMPTS times it's
// quarantined: never offered again, so a broken release can't trap the app
// in a download-restart-fail loop forever.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BREVI_HOME } from "@brevi/shared";

export const UPDATE_STATE_PATH: string = join(BREVI_HOME, "desktop-update.json");

/** A version gets one retry before it's quarantined; see reconcile. */
export const MAX_INSTALL_ATTEMPTS = 2;

export interface PendingInstall {
  /** Version we asked electron-updater to install. */
  version: string;
  /** Version that was running when we asked, so a failed install is visible as "still on `from`". */
  from: string;
  attempts: number;
  startedAt: string; // ISO
}

export interface DesktopUpdateState {
  pending?: PendingInstall;
  /** Versions that failed to install MAX_INSTALL_ATTEMPTS times; never offered again. */
  quarantined: string[];
}

function emptyState(): DesktopUpdateState {
  return { quarantined: [] };
}

function isPendingInstall(value: unknown): value is PendingInstall {
  if (typeof value !== "object" || value === null) return false;
  const { version, from, attempts, startedAt } = value as Record<string, unknown>;
  return (
    typeof version === "string" &&
    typeof from === "string" &&
    typeof attempts === "number" &&
    typeof startedAt === "string"
  );
}

/**
 * Reads the update state file, defensively. Missing file, unreadable file,
 * malformed JSON, or a shape that doesn't match what we expect all fall back
 * to an empty state rather than throwing: this file is disposable bookkeeping,
 * never something worth crashing the app over.
 */
export function readUpdateState(path: string = UPDATE_STATE_PATH): DesktopUpdateState {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return emptyState();
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return emptyState();
  }

  if (typeof value !== "object" || value === null) return emptyState();
  const { pending, quarantined } = value as Record<string, unknown>;

  const state = emptyState();
  if (Array.isArray(quarantined) && quarantined.every((entry) => typeof entry === "string")) {
    state.quarantined = quarantined;
  }
  if (isPendingInstall(pending)) {
    state.pending = pending;
  }
  return state;
}

/**
 * Writes the update state file, best-effort. Creates ~/.brevi if it doesn't
 * exist yet and swallows its own errors: bookkeeping for the updater must
 * never crash the app, even on a read-only filesystem or a permissions
 * problem.
 */
export function writeUpdateState(state: DesktopUpdateState, path: string = UPDATE_STATE_PATH): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    // Bookkeeping only; losing a write just means the next reconcile has
    // slightly stale information, never a crash.
  }
}

/**
 * Records that we've asked electron-updater to install version `to`, on top
 * of the version `from` that's currently running. Pure: returns a new state
 * rather than mutating. If we already have a pending install for the same
 * target version, this is a retry: bump `attempts` and refresh `startedAt`
 * rather than resetting the counter, so repeated failures of the same
 * version are actually counted toward MAX_INSTALL_ATTEMPTS.
 */
export function markInstallStarted(state: DesktopUpdateState, from: string, to: string): DesktopUpdateState {
  const existing = state.pending;
  const pending: PendingInstall =
    existing && existing.version === to
      ? { ...existing, attempts: existing.attempts + 1, startedAt: new Date().toISOString() }
      : { version: to, from, attempts: 1, startedAt: new Date().toISOString() };
  return { ...state, pending };
}

/**
 * Reconciles pending install bookkeeping against the version that's actually
 * running after a restart. Pure: returns a new state plus, when the install
 * didn't take, the version that failed.
 *
 * No pending install: nothing to reconcile, state passes through unchanged.
 *
 * `pending.version === runningVersion`: the install succeeded, clear it.
 *
 * Otherwise the install did not take, and the app came back up still on the
 * old version, that mismatch IS the rollback (see the module docstring):
 * electron-updater only swaps the app in on success, so a failed install
 * simply leaves the previous install untouched and it's what starts back up.
 * Report `failed: pending.version`. If this was already the last allowed
 * attempt, clear `pending` and quarantine the version (deduplicated) so it's
 * never offered again; otherwise leave `pending` in place so the next
 * attempt still counts against the cap.
 */
export function reconcile(
  state: DesktopUpdateState,
  runningVersion: string,
): { state: DesktopUpdateState; failed?: string } {
  const pending = state.pending;
  if (!pending) return { state };

  if (pending.version === runningVersion) {
    const { pending: _dropped, ...rest } = state;
    return { state: { ...rest, quarantined: state.quarantined } };
  }

  if (pending.attempts >= MAX_INSTALL_ATTEMPTS) {
    const quarantined = state.quarantined.includes(pending.version)
      ? state.quarantined
      : [...state.quarantined, pending.version];
    const { pending: _dropped, ...rest } = state;
    return { state: { ...rest, quarantined }, failed: pending.version };
  }

  return { state, failed: pending.version };
}

/** True when `version` failed to install MAX_INSTALL_ATTEMPTS times and should never be offered again. */
export function isQuarantined(state: DesktopUpdateState, version: string): boolean {
  return state.quarantined.includes(version);
}
