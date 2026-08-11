import { WORKER_DEMAND_PATH, WORKER_SELF_STATE_PATH, type FleetDemandResponse } from "@brevi/shared";
import { errorMessage } from "../lib/util.js";
import {
  mayStopAfterReservation,
  nextSupervisorDecision,
  type DemandSnapshot,
  type SupervisorState,
} from "./idle.js";
import { limaShell, limaStart, limaStatus, limaStop } from "./limactl.js";
import { saveMacVmSettings, type MacVmSettings } from "./state.js";

/**
 * The loop launchd runs (`brevi mac supervise`): the whole of the macOS-side
 * behaviour. It never executes runs itself; it only asks the host what it
 * needs (`fetchDemand`) and turns that into a start/stop decision via the
 * pure `nextSupervisorDecision` policy in `./idle.ts`, then acts on it with
 * the `limactl` wrappers in `./limactl.ts`.
 */

export interface SupervisorOptions {
  settings: MacVmSettings;
  log?: (line: string) => void;
  signal?: AbortSignal;
}

/** Where the guest records the enrollment it earned from the host; see @brevi/worker's identity.ts. */
const GUEST_ENROLLMENT_PATH = "/root/.brevi/worker.json";

/** A network timeout comfortably shorter than the shortest allowed poll interval (5s). */
const FETCH_TIMEOUT_MS = 10_000;

function isFleetDemandResponse(value: unknown): value is FleetDemandResponse {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Record<string, unknown>;
  return (
    typeof body.queuedRuns === "number" &&
    typeof body.activeRuns === "number" &&
    typeof body.connectedWorkers === "number" &&
    typeof body.worker === "object" &&
    body.worker !== null
  );
}

/**
 * One authenticated call to the worker-supervisor API, as this worker.
 * Undefined when the host is unreachable, refuses the credential, or answers
 * something this version does not understand, all of which the policy in
 * `./idle.ts` treats the same way: leave the VM as it stands.
 *
 * Every call authenticates as the guest's own worker, with the credential
 * read off it by `learnEnrollment`. Until that has happened there is nothing
 * to authenticate with, so the supervisor has no opinion yet either.
 */
async function callWorkerApi(
  settings: MacVmSettings,
  path: string,
  method: "GET" | "POST",
  params: Record<string, string> = {},
): Promise<DemandSnapshot | undefined> {
  if (settings.workerId === "" || settings.credential === "") return undefined;

  const url = new URL(path, settings.hostUrl);
  url.searchParams.set("workerId", settings.workerId);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${settings.credential}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  if (!isFleetDemandResponse(body)) return undefined;

  return {
    queuedRuns: body.queuedRuns,
    workerConnected: body.worker.connected,
    workerActiveRuns: body.worker.activeRuns,
    workerAttachSessions: body.worker.attachSessions,
    // Anything other than a host that positively says "active" is treated as
    // drained, so a host too old to report the field at all keeps this VM
    // asleep rather than booting it for work it would never be given. The one
    // exception is a drain this supervisor placed itself to reserve the
    // machine for shutdown: that is ours to lift, so it must not read as a
    // reason to leave the VM stopped forever.
    workerEligible: body.worker.state === "active" || settings.selfDrained,
  };
}

/** Ask the host what it has queued and how busy this worker is. */
export async function fetchDemand(settings: MacVmSettings): Promise<DemandSnapshot | undefined> {
  return callWorkerApi(settings, WORKER_DEMAND_PATH, "GET");
}

/** Set this worker's own state on the host, answered with the demand as it stands afterwards. */
async function setOwnState(
  settings: MacVmSettings,
  state: "active" | "draining",
): Promise<DemandSnapshot | undefined> {
  return callWorkerApi(settings, WORKER_SELF_STATE_PATH, "POST", { state });
}

function timestampedLog(log: (line: string) => void, line: string): void {
  log(`[brevi] ${new Date().toISOString()} ${line}`);
}

/** A sleep that resolves early when `signal` aborts, so SIGTERM is handled promptly. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** A plausible secret or id: non-empty, single line, no whitespace, sane length. */
function isPlausibleSecret(candidate: unknown): candidate is string {
  return typeof candidate === "string" && candidate.length > 0 && candidate.length <= 200 && !/\s/.test(candidate);
}

/**
 * While the VM is running and its enrollment isn't known out here yet, copies
 * the id and credential the host issued it off the guest and persists them.
 * That is what later ticks poll the host with, including the ticks taken
 * while the VM is stopped, when there is no guest to ask anything.
 *
 * The pairing token is dropped in the same write: it was single-use, the
 * credential is proof it has been spent, and leaving it on the ExecStart line
 * would only make every guest restart fail an enrollment attempt before
 * falling back to the credential.
 */
async function learnEnrollment(
  settings: MacVmSettings,
  log: (line: string) => void,
): Promise<MacVmSettings> {
  const result = await limaShell(settings.name, ["sudo", "cat", GUEST_ENROLLMENT_PATH]);
  if (result.exitCode !== 0) return settings;

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return settings;
  }
  if (typeof parsed !== "object" || parsed === null) return settings;
  const { workerId, credential } = parsed as Record<string, unknown>;
  if (!isPlausibleSecret(workerId) || !isPlausibleSecret(credential)) return settings;

  const updated: MacVmSettings = { ...settings, workerId, credential, token: "" };
  await saveMacVmSettings(updated);
  timestampedLog(log, `Learned this VM's enrollment: worker ${workerId}.`);
  return updated;
}

/**
 * Hold this worker out of placement before powering its machine off, and
 * report whether the shutdown may go ahead.
 *
 * The drain and the "what is still in flight" read are one round trip (see
 * WORKER_SELF_STATE_PATH): by the time the answer is written, the scheduler
 * has already stopped placing runs here, so what it reports in flight is the
 * complete set, and `mayStopAfterReservation` decides on that rather than on
 * a snapshot that a dispatch could invalidate a millisecond later.
 */
async function reserveForStop(
  settings: MacVmSettings,
  workerEligible: boolean,
  log: (line: string) => void,
): Promise<{ settings: MacVmSettings; proceed: boolean }> {
  // An operator-drained worker is already excluded from placement, so there
  // is nothing to reserve, and nothing this supervisor would be entitled to
  // put back afterwards.
  if (!workerEligible) return { settings, proceed: true };

  const after = await setOwnState(settings, "draining");
  if (after === undefined) {
    timestampedLog(log, "Could not reserve this worker on the host; leaving the VM up.");
    return { settings, proceed: false };
  }

  // Recorded only once the host has confirmed the drain, so a failed call
  // never leaves this supervisor believing it may re-activate a worker an
  // operator drained. The reverse gap (killed after the drain, before this
  // write) leaves the worker drained and visible on the Workers page, which
  // is the safer of the two to be wrong about.
  const reserved = { ...settings, selfDrained: true };
  await saveMacVmSettings(reserved);

  if (!mayStopAfterReservation(after)) {
    timestampedLog(
      log,
      `Work landed while reserving this worker (${after.workerActiveRuns} run(s), ${after.workerAttachSessions} attach session(s)); leaving the VM up.`,
    );
    return { settings: reserved, proceed: false };
  }
  return { settings: reserved, proceed: true };
}

/**
 * Undo a reservation this supervisor made. The flag stays set when the host
 * cannot be reached, so a later tick retries rather than silently leaving the
 * worker drained with nothing recording that it was ours to lift.
 */
async function releaseReservation(
  settings: MacVmSettings,
  log: (line: string) => void,
): Promise<MacVmSettings> {
  if (!settings.selfDrained) return settings;
  if ((await setOwnState(settings, "active")) === undefined) {
    timestampedLog(log, "Could not put this worker back in rotation on the host; retrying next tick.");
    return settings;
  }
  const released = { ...settings, selfDrained: false };
  await saveMacVmSettings(released);
  timestampedLog(log, "Released this worker's shutdown reservation; it is back in rotation.");
  return released;
}

/** Poll, decide with nextSupervisorDecision, act. Resolves when the signal aborts. */
export async function runSupervisor(options: SupervisorOptions): Promise<void> {
  const log = options.log ?? console.log;
  const emit = (line: string) => timestampedLog(log, line);

  let settings = options.settings;
  let state: SupervisorState = {};
  let lastLoggedReason: string | undefined;

  while (options.signal?.aborted !== true) {
    let vmRunning = (await limaStatus(settings.name)) === "Running";
    const demand = await fetchDemand(settings);

    const decision = nextSupervisorDecision(state, {
      nowMs: Date.now(),
      vmRunning,
      demand,
      idleStopMinutes: settings.idleStopMinutes,
    });
    state = decision.state;

    if (decision.reason !== lastLoggedReason) {
      emit(decision.reason);
      lastLoggedReason = decision.reason;
    }

    if (decision.action === "start") {
      try {
        await limaStart(settings.name, (line) => emit(`lima: ${line}`));
        vmRunning = true;
      } catch (err) {
        emit(`Failed to start the VM: ${errorMessage(err)}`);
      }
    } else if (decision.action === "stop") {
      const reservation = await reserveForStop(settings, demand?.workerEligible === true, log);
      settings = reservation.settings;
      if (reservation.proceed) {
        try {
          await limaStop(settings.name);
          vmRunning = false;
        } catch (err) {
          emit(`Failed to stop the VM: ${errorMessage(err)}`);
        }
      }
    }

    // A reservation only ever covers a machine on its way down, so any tick
    // that ends with the VM still running has to give it up: the stop was
    // skipped because work arrived, or it failed, or the machine has since
    // been started again. One place rather than three, so no path can forget.
    if (vmRunning && settings.selfDrained) {
      settings = await releaseReservation(settings, log);
    }

    if (vmRunning && settings.credential === "") {
      settings = await learnEnrollment(settings, log);
    }

    await abortableSleep(settings.pollSeconds * 1000, options.signal);
  }
}
