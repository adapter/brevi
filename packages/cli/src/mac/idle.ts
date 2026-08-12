/**
 * The macOS worker supervisor's decision, as a pure state machine: given what
 * the host reported on this tick and what the supervisor already knows, it
 * says whether to start or stop the managed VM. Keeping the policy pure (no
 * `limactl`, no clock reads beyond the `nowMs` passed in) is what makes the
 * idle-stop and cold-start behavior testable without a VM.
 */

/** What the host reported on this tick; see GET WORKER_DEMAND_PATH. */
export interface DemandSnapshot {
  queuedRuns: number;
  workerConnected: boolean;
  workerActiveRuns: number;
  workerAttachSessions: number;
  /**
   * Whether the host would actually dispatch to this worker. False while it
   * is drained: the scheduler skips draining workers, so `queuedRuns` is then
   * work this machine will never be given, and treating it as a reason to be
   * awake would boot a VM that sits idle until someone re-enables it.
   */
  workerEligible: boolean;
}

export interface SupervisorState {
  /** Epoch ms the VM has been continuously idle since; absent when it is busy or stopped. */
  idleSinceMs?: number;
}

export interface SupervisorTick {
  nowMs: number;
  vmRunning: boolean;
  /** Absent when the host could not be reached on this tick. */
  demand?: DemandSnapshot;
  idleStopMinutes: number;
}

export type SupervisorAction = "start" | "stop" | "none";

export interface SupervisorDecision {
  action: SupervisorAction;
  /** One line for the supervisor log, explaining the action or the wait. */
  reason: string;
  /** The state to carry into the next tick. */
  state: SupervisorState;
}

/**
 * Work queued on the host that this worker could be given. Drained, there is
 * none by definition, however long the host's queue is: those runs are going
 * to other workers, or waiting for one, either way not for this machine.
 */
function claimableQueue(demand: DemandSnapshot): number {
  return demand.workerEligible ? demand.queuedRuns : 0;
}

/**
 * Idle when running and none of these hold: a run this worker is executing,
 * an attach session against one of its sandboxes, or host work it could take.
 * Runs already in flight and open attach sessions count whatever the worker's
 * state is: draining means "accept nothing new", not "abandon what you hold".
 */
function isBusy(demand: DemandSnapshot): boolean {
  return claimableQueue(demand) > 0 || demand.workerActiveRuns > 0 || demand.workerAttachSessions > 0;
}

/**
 * The second half of an idle stop, applied to the demand the host reports
 * *after* it has been asked to drain this worker.
 *
 * A `stop` decision is made from a snapshot, and a snapshot cannot be acted
 * on safely: a run queued a millisecond later is dispatched to a worker that
 * is still online, and cutting the power then kills it mid-execution (the
 * host gives up on it once the reconnect grace expires). Draining first is
 * what makes the pair atomic, since the scheduler stops placing runs here
 * before the answer is sent. So whatever that answer still reports in flight
 * is the complete set of work the shutdown would destroy, and any of it at
 * all means the machine stays up.
 *
 * The queue is deliberately not consulted: a drained worker will not be given
 * those runs, and they are precisely what this shutdown is getting out of the
 * way of.
 */
export function mayStopAfterReservation(demand: DemandSnapshot): boolean {
  return demand.workerActiveRuns === 0 && demand.workerAttachSessions === 0;
}

export function nextSupervisorDecision(
  state: SupervisorState,
  tick: SupervisorTick,
): SupervisorDecision {
  const { nowMs, vmRunning, demand, idleStopMinutes } = tick;

  // A supervisor that cannot see the host must not stop a VM that may be
  // mid-run, and must not boot one on a guess of what the host wants. Wait
  // for the next tick with an answer instead. Absent demand covers both an
  // unreachable host and a supervisor that has not yet copied the guest's
  // enrollment out of it, so it cannot ask about that worker at all.
  if (demand === undefined) {
    return { action: "none", reason: "No answer from the host; holding the VM as-is.", state };
  }

  if (!vmRunning) {
    const claimable = claimableQueue(demand);
    if (claimable > 0) {
      return {
        action: "start",
        reason: `${claimable} run(s) queued; starting the VM.`,
        state: {},
      };
    }
    if (!demand.workerEligible && demand.queuedRuns > 0) {
      return {
        action: "none",
        reason: `VM stopped and this worker is drained; the host's ${demand.queuedRuns} queued run(s) are not for it.`,
        state: {},
      };
    }
    return { action: "none", reason: "VM stopped and nothing queued.", state: {} };
  }

  // Running. A VM whose worker has not registered yet (workerConnected
  // false, all counts zero) still counts as idle here, which is correct:
  // the idle window is minutes, and the timer restarts the moment any work
  // appears, so a slow-booting worker just delays the stop rather than being
  // treated specially.
  if (isBusy(demand)) {
    return { action: "none", reason: "VM is busy.", state: {} };
  }

  if (idleStopMinutes === 0) {
    return { action: "none", reason: "Idle, but auto-stop is disabled.", state: {} };
  }

  const idleSinceMs = state.idleSinceMs ?? nowMs;
  const idleForMs = nowMs - idleSinceMs;
  const thresholdMs = idleStopMinutes * 60_000;
  if (idleForMs >= thresholdMs) {
    return {
      action: "stop",
      reason: `Idle for ${Math.floor(idleForMs / 60_000)} minute(s), reached the ${idleStopMinutes} minute threshold; stopping the VM.`,
      // The expired timer is carried, not cleared. Deciding to stop is not the
      // same as having stopped: `limactl stop` can fail transiently, and
      // clearing it here would open a fresh idle window on the next tick, so
      // the retry would be a whole idleStopMinutes away. A stop that does
      // succeed discards this on the very next tick anyway, since every
      // `!vmRunning` branch above returns an empty state.
      state: { idleSinceMs },
    };
  }

  return {
    action: "none",
    reason: `Idle for ${Math.floor(idleForMs / 60_000)} minute(s) of ${idleStopMinutes}.`,
    state: { idleSinceMs },
  };
}
