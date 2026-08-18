import type { Run, RunStatus } from "@brevi/shared";
// Type-only: keeps this module free of the `electron` import so it can be
// unit tested under bun (see the docstring on FleetTray for why the rest of
// the tray stack may not be).
import type { SupervisorState } from "./supervisor.js";

/**
 * Statuses the orchestrator hasn't finished with yet, matching
 * apps/app/src/lib/status.ts's `isActive`. Kept here rather than imported
 * since the dashboard package isn't a dependency of the desktop app.
 */
export const ACTIVE_STATUSES: ReadonlySet<RunStatus> = new Set([
  "queued",
  "preparing",
  "running",
  "finalizing",
  "waiting",
]);

export interface FleetCounts {
  active: number;
  queued: number;
  waiting: number;
  failed: number;
  total: number;
}

/** Queue and worker counts behind the tray's status line. "active" is a run the orchestrator is working on right now; "queued" is waiting for a slot. */
export function countRuns(runs: readonly Run[]): FleetCounts {
  let active = 0;
  let queued = 0;
  let waiting = 0;
  let failed = 0;
  for (const run of runs) {
    if (ACTIVE_STATUSES.has(run.status)) active++;
    if (run.status === "queued") queued++;
    if (run.status === "waiting") waiting++;
    if (run.status === "failed") failed++;
  }
  return { active, queued, waiting, failed, total: runs.length };
}

/** macOS menu-bar title: the active count while work is happening, empty when idle (an icon-only tray). */
export function trayTitle(counts: FleetCounts): string {
  return counts.active > 0 ? String(counts.active) : "";
}

/**
 * Count of runs the orchestrator is executing right now: "active" minus the
 * runs that are merely queued or parked waiting on a human. This is the
 * number a person reads in the tray, not the one that gates an update (see
 * updateBlockingRuns). Clamped at 0 defensively; the buckets should never
 * disagree, but a caller passing inconsistent counts shouldn't produce a
 * negative "running".
 */
export function runningCount(counts: FleetCounts): number {
  return Math.max(0, counts.active - counts.queued - counts.waiting);
}

/**
 * Count of runs a restart-to-update would disrupt, which is what gates the
 * automatic install (see shouldInstallNow in update-policy.ts): the runs
 * being executed right now plus the ones still queued. A queued run counts
 * even though nothing is executing it yet, because Scheduler.stop() cancels
 * every entry left in the queue on shutdown (see
 * packages/orchestrator/src/scheduler.ts), so restarting under a queue
 * throws submitted work away rather than delaying it. A waiting run is
 * parked on a human's input and is rescheduled on the next boot, so it
 * survives a restart and never blocks. Clamped at 0 like runningCount, for
 * the same reason.
 */
export function updateBlockingRuns(counts: FleetCounts): number {
  return Math.max(0, counts.active - counts.waiting);
}

/** One-line fleet summary, e.g. "2 running, 3 queued" or "Idle". */
export function fleetLine(counts: FleetCounts): string {
  // "active" also covers queued and waiting runs (see ACTIVE_STATUSES); the
  // line breaks it back into the buckets a person actually cares about.
  const running = runningCount(counts);
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (counts.queued > 0) parts.push(`${counts.queued} queued`);
  if (counts.waiting > 0) parts.push(`${counts.waiting} waiting`);
  return parts.length > 0 ? parts.join(", ") : "Idle";
}

/** One-line status for the orchestrator owned by Mission Control. */
export function workerLine(state: SupervisorState): string {
  switch (state.kind) {
    case "starting":
      return "Orchestrator: starting...";
    case "running":
      return `Orchestrator: running (pid ${state.pid})`;
    case "failed":
      return `Orchestrator: failed (${state.reason})`;
    case "stopped":
      return "Orchestrator: stopped";
    default:
      return "Orchestrator: unknown";
  }
}

function runTimestamp(run: Run): number {
  return Date.parse(run.finishedAt ?? run.startedAt ?? run.createdAt);
}

/** How far along the pipeline a status is, so the menu leads with the runs actually moving. */
const STATUS_RANK: Record<RunStatus, number> = {
  finalizing: 0,
  running: 1,
  preparing: 2,
  queued: 3,
  waiting: 4,
  completed: 5,
  failed: 5,
  cancelled: 5,
};

/** The runs worth showing in the menu: active first (furthest along, then newest), then the most recent finished ones, capped at `limit`. */
export function menuRuns(runs: readonly Run[], limit: number): Run[] {
  const active = runs.filter((run) => ACTIVE_STATUSES.has(run.status));
  const finished = runs.filter((run) => !ACTIVE_STATUSES.has(run.status));
  active.sort(
    (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || runTimestamp(b) - runTimestamp(a),
  );
  finished.sort((a, b) => runTimestamp(b) - runTimestamp(a));
  return [...active, ...finished].slice(0, limit);
}

function statusLabel(status: RunStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/** Menu label for one run, e.g. "PD-60  Running". */
export function runLabel(run: Run): string {
  return `${run.ticket.identifier}  ${statusLabel(run.status)}`;
}
