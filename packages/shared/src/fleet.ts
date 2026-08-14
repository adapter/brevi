import type { WorkerCapabilities } from "./worker.js";

/**
 * Enrollment: how a machine becomes one of this host's workers, and how the
 * dashboard sees the fleet afterwards. The wire protocol those workers speak
 * once enrolled lives in worker.ts; this module holds only what enrollment
 * itself and Mission Control's Workers page need, so it stays free of zod and
 * of node builtins and can be imported from the browser bundle.
 *
 * Two secrets exist, with deliberately different lifetimes. A pairing token is
 * minted by Mission Control, printed inside the `brevi worker` command a human
 * copies to the new machine, and dies the moment it is redeemed or its short
 * expiry passes. What it buys is a durable per-worker credential, which is the
 * only thing the worker keeps on disk and the only thing that authenticates it
 * afterwards. Revoking a worker invalidates that credential, so a revoked
 * machine cannot come back with what it already has.
 *
 * Connector secrets never take part in enrollment. Agent and GitHub
 * credentials travel inside a dispatch, over the authenticated channel, and
 * live only as long as the run they belong to.
 */

/**
 * Operator-controlled state of a worker. "draining" finishes in-flight runs
 * and accepts nothing new; it survives restarts and reconnects, so a machine
 * being decommissioned stays out of rotation on its own.
 */
export type WorkerState = "active" | "draining";

/** Whether the worker currently holds an open channel to the host. */
export type WorkerConnection = "online" | "offline";

/**
 * One enrolled worker as the dashboard sees it, whether or not it is
 * connected right now. No credential material appears here, in any form: the
 * host stores only a hash, and even that never leaves the process.
 */
export interface WorkerView {
  id: string;
  name: string;
  state: WorkerState;
  connection: WorkerConnection;
  /**
   * True for the worker the host spawns and supervises on its own machine:
   * enrolled without a pairing token, shown as "This machine", drainable but
   * never renamed or revoked.
   */
  local?: boolean;
  /** Last reported capabilities; absent for a worker that has never connected. */
  capabilities?: WorkerCapabilities;
  /** Runs this worker holds an active lease for right now. */
  activeRuns: number;
  enrolledAt: string;
  /** When the current connection was established; absent while offline. */
  connectedAt?: string;
  /** ISO timestamp of the last register or heartbeat, absent until the first connect. */
  lastSeenAt?: string;
  /** Remote address of the live channel, when connected. */
  address?: string;
}

/**
 * A freshly minted pairing token. Returned exactly once, by the mint call
 * that created it: the host keeps only what it needs to redeem the token, so
 * a token that is not copied out of this response is unrecoverable.
 */
export interface PairingTokenResponse {
  /** The secret itself. Single-use, and dead at `expiresAt` if never redeemed. */
  token: string;
  expiresAt: string;
  /** Ready to copy: `brevi worker --host <url> --token <token>`. */
  command: string;
  /** Host URL baked into the command, so the dashboard can explain a wrong guess. */
  host: string;
  /**
   * Whether `host` is reachable from another machine: false when the only
   * listener bound is loopback-only, or when a wildcard bind produced no
   * usable LAN address to guess. The dashboard uses this to warn when the
   * printed command will only ever work on this machine.
   */
  remote: boolean;
}

/** Fleet snapshot: every enrolled worker, oldest enrollment first. */
export interface FleetResponse {
  workers: WorkerView[];
}

/**
 * Whether the machine running the orchestrator can execute runs, and through
 * what: a host-supervised local worker (Linux), the managed macOS worker VM,
 * or nothing. Computed at startup by the process booting the orchestrator,
 * reported on /api/health, and used by Mission Control to explain a queue
 * that cannot drain on its own; the reason says what would fix it.
 */
export type HostExecution =
  | { kind: "local-worker" }
  | { kind: "mac-vm" }
  | { kind: "none"; reason: "macos-vm-not-installed" | "unsupported-platform" };

/** Body of POST /api/workers/:id/rename. */
export interface WorkerRenameRequest {
  name: string;
}

/** How long an unredeemed pairing token stays valid, in minutes. */
export const PAIRING_TOKEN_TTL_MINUTES = 15;
