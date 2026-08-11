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

/** One-line fleet summary, e.g. "2 running, 3 queued" or "Idle". */
export function fleetLine(counts: FleetCounts): string {
  // "active" also covers queued and waiting runs (see ACTIVE_STATUSES); the
  // line breaks it back into the buckets a person actually cares about.
  const running = Math.max(0, counts.active - counts.queued - counts.waiting);
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (counts.queued > 0) parts.push(`${counts.queued} queued`);
  if (counts.waiting > 0) parts.push(`${counts.waiting} waiting`);
  return parts.length > 0 ? parts.join(", ") : "Idle";
}

/** One-line orchestrator health, e.g. "Orchestrator: running (pid 4021)", "Orchestrator: attached to CLI (pid 918)", "Orchestrator: restarting in 4s (attempt 2)". */
export function workerLine(state: SupervisorState): string {
  switch (state.kind) {
    case "starting":
      return "Orchestrator: starting...";
    case "running":
      return `Orchestrator: running (pid ${state.pid})`;
    case "attached":
      return state.pid !== null
        ? `Orchestrator: attached to CLI (pid ${state.pid})`
        : "Orchestrator: attached to CLI";
    case "restarting":
      return `Orchestrator: restarting in ${Math.ceil(state.delayMs / 1000)}s (attempt ${state.attempt})`;
    case "failed":
      return `Orchestrator: failed (${state.reason})`;
    case "stopped":
      return "Orchestrator: stopped";
    case "idle":
      return `Orchestrator: stopped (${state.reason})`;
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
