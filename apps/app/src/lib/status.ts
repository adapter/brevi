import type { RunStatus } from "@brevi/shared";

/**
 * One status vocabulary for the whole interface. Queue chips, run strips, the
 * phase spine and the console dividers all read their colours from here, so a
 * colour always means the same thing wherever it shows up.
 */
export interface StatusTone {
  label: string;
  /** Text colour class. */
  fg: string;
  /** Solid fill for dots, nodes and bars. */
  fill: string;
  /** Low-contrast wash for chip backgrounds. */
  wash: string;
  /** Chip border. */
  edge: string;
  /** True while the orchestrator is still working on the run. */
  active: boolean;
}

export const STATUS_TONE: Record<RunStatus, StatusTone> = {
  queued: {
    label: "Queued",
    fg: "text-haze-400",
    fill: "bg-haze-600",
    wash: "bg-haze-600/10",
    edge: "border-haze-700/50",
    active: true,
  },
  preparing: {
    label: "Preparing",
    fg: "text-peri-400",
    fill: "bg-peri-400",
    wash: "bg-peri-400/12",
    edge: "border-peri-400/35",
    active: true,
  },
  running: {
    label: "Running",
    fg: "text-ember-500",
    fill: "bg-ember-500",
    wash: "bg-ember-500/12",
    edge: "border-ember-500/40",
    active: true,
  },
  finalizing: {
    label: "Finalizing",
    fg: "text-ember-300",
    fill: "bg-ember-300",
    wash: "bg-ember-300/12",
    edge: "border-ember-300/35",
    active: true,
  },
  waiting: {
    label: "Waiting",
    fg: "text-iris-400",
    fill: "bg-iris-400",
    wash: "bg-iris-400/12",
    edge: "border-iris-400/35",
    active: true,
  },
  completed: {
    label: "Completed",
    fg: "text-mint-400",
    fill: "bg-mint-500",
    wash: "bg-mint-500/12",
    edge: "border-mint-500/35",
    active: false,
  },
  failed: {
    label: "Failed",
    fg: "text-rust-400",
    fill: "bg-rust-500",
    wash: "bg-rust-500/12",
    edge: "border-rust-500/40",
    active: false,
  },
  cancelled: {
    label: "Cancelled",
    fg: "text-haze-600",
    fill: "bg-haze-700",
    wash: "bg-haze-700/10",
    edge: "border-haze-700/40",
    active: false,
  },
};

export const PHASES = ["queued", "preparing", "running", "finalizing"] as const;
export type Phase = (typeof PHASES)[number];

export function isActive(status: RunStatus): boolean {
  return STATUS_TONE[status].active;
}

export function isTerminal(status: RunStatus): boolean {
  return !STATUS_TONE[status].active;
}

/** How far along the pipeline a run has got, 0-3. Terminal runs are past the end. */
export function phaseIndex(status: RunStatus): number {
  const i = (PHASES as readonly string[]).indexOf(status);
  return i === -1 ? PHASES.length : i;
}
