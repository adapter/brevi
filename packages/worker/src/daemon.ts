import { readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  CONFIG_DEFAULTS,
  FIRECRACKER_SIZES,
  WORKSPACES_DIR,
  type BreviConfig,
  type CancelMessage,
  type DiscardMessage,
  type DispatchMessage,
  type FirecrackerVmSize,
  type Run,
  type RunCompleteAckMessage,
  type RunCompleteMessage,
  type RunLease,
  type RunStatus,
  type WorkerCapabilities,
  type WorkerMessage,
  type WorkerState,
} from "@brevi/shared";
import { createSandboxProvider, isReadWritable, type SandboxProvider } from "@brevi/sandbox";
import { loadConfig } from "@brevi/orchestrator";
import { isTerminal, LinearService } from "@brevi/orchestrator/internal";
import { createAttachSessions, type AttachSessions } from "./attach.js";
import { connectToHost, type WorkerConnection } from "./connection.js";
import { executeFollowUp } from "./followup.js";
import { clearEnrollment, enrollmentFor, saveEnrollment } from "./identity.js";
import { RunReporter } from "./reporter.js";
import { executeRun, type RunContext } from "./runner.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** This package's own version, reported as the worker's build (mirrors the orchestrator's server.ts, which reports the same way for /api/health). */
const VERSION = ((): string => {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

export interface WorkerOptions {
  /** The host's base url, e.g. "http://localhost:4400". */
  hostUrl: string;
  /**
   * A single-use pairing token, minted on the host's Workers page. Only
   * needed to enroll: the first time this machine connects to that host, or
   * to enroll it again after its credential was revoked. Once redeemed, the
   * durable credential in `~/.brevi/worker.json` authenticates every later
   * connect, so the daemon normally runs without a token at all.
   */
  token?: string;
  /** The name to enroll under; defaults to this machine's hostname. The host keeps its own name for this worker afterwards, so a rename happens on the dashboard. */
  name?: string;
  /** Overrides the local config's sandbox.concurrency for how many dispatched runs this worker executes at once. */
  concurrency?: number;
  /** Worker's own ~/.brevi/config.json path override, mainly for tests. */
  configPath?: string;
}

/**
 * How long shutdown waits for active runs to abort, finish their terminal
 * reporting, and have the connection flush it before giving up on a clean
 * stop and closing anyway.
 */
const SHUTDOWN_DEADLINE_MS = 30_000;

interface ActiveRun {
  lease: RunLease;
  abort: AbortController;
  reporter: RunReporter;
  /** Resolves once handleDispatch's finally block has sent this run's run-complete; shutdown awaits these instead of abandoning them mid-flight. */
  execution: Promise<void>;
}

/** The final terminal/waiting status a settled run leaves behind, mapped to run-complete's outcome. */
function outcomeFor(status: RunStatus): RunCompleteMessage["outcome"] {
  switch (status) {
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "waiting":
      return "waiting";
    default:
      // executeRun/executeFollowUp never return leaving the run non-terminal
      // and non-waiting except when they themselves crashed unexpectedly;
      // either way "failed" is the honest outcome to report.
      return "failed";
  }
}

/**
 * The run's whole terminal state, read back off the reporter's final
 * snapshot rather than assembled field by field here: a dropped socket can
 * lose individual run-patch frames along the way, and this is the one frame
 * the worker holds its lease open for until the host has it (see
 * claimedLeases below), so it has to carry the full story on its own.
 * `reporter.artifacts` is the manifest of what actually transferred under
 * this lease; a skipped oversized artifact never appears in it.
 */
function runCompleteFor(leaseId: string, runId: string, reporter: RunReporter): RunCompleteMessage {
  const run = reporter.run;
  return {
    type: "run-complete",
    leaseId,
    runId,
    outcome: outcomeFor(run.status),
    finishedAt: run.finishedAt,
    error: run.error,
    result: run.result,
    artifacts: reporter.artifacts,
    prUrl: run.prUrl,
    prState: run.prState,
    limit: run.limit,
    resumeAt: run.resumeAt,
    attempts: run.attempts,
    costs: run.costs,
    costTotals: run.costTotals,
    agentSessionId: run.agentSessionId,
    sandbox: { provider: run.sandbox.provider, id: run.sandbox.id, retainedUntil: run.sandbox.retainedUntil },
  };
}

/** Resolves "timeout" instead of `promise`'s value when `ms` passes first, so a caller can tell a deadline was hit apart from a legitimate result. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  return Promise.race([promise, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), Math.max(0, ms)))]);
}

/**
 * Runs the worker daemon in the foreground: enrolls with the host (or
 * reconnects with the credential an earlier enrollment left behind), executes
 * whatever it dispatches, and mirrors every run mutation back over the
 * socket. Resolves once a SIGINT/SIGTERM shuts it down cleanly and rejects
 * when the host revoked this machine's enrollment; the caller (packages/cli's
 * `brevi worker` command) just awaits it.
 */
export async function runWorker(options: WorkerOptions): Promise<void> {
  const name = options.name ?? hostname();
  // A machine that only ever runs `brevi worker` has no reason to have run
  // `brevi init`, so an absent (or unreadable) config is not fatal here the
  // way it is for every other command: fall back to the schema's own
  // defaults, which is a process-provider worker with concurrency 1.
  const config = await loadConfig(options.configPath).catch((error: unknown) => {
    console.log(`[brevi] no usable local config (${errorMessage(error)}); continuing with defaults`);
    return CONFIG_DEFAULTS;
  });
  const concurrency = options.concurrency ?? config.sandbox.concurrency;
  // The credential an earlier enrollment on this host left behind, if any.
  // Scoped to the host: a credential another brevi instance issued is not
  // something this one would honour, so it counts as not being enrolled.
  const enrollment = await enrollmentFor(options.hostUrl);

  console.log(`[brevi] resolving the ${config.sandbox.provider} sandbox provider...`);
  const provider: SandboxProvider = await createSandboxProvider({
    requested: config.sandbox.provider,
    firecracker: config.sandbox.firecracker,
    concurrency,
    // Prebuilt rootfs images are cached per @brevi/cli release, so the worker's
    // own version is the cache key its images resolve under. The worker is the
    // machine that boots VMs now, so it is also the one that downloads them:
    // surface the progress rather than sitting silent through a multi-GB pull.
    cliVersion: VERSION,
    log: (line) => console.log(`[brevi] ${line}`),
  });
  await provider.ensureAvailable();

  const capabilities: WorkerCapabilities = {
    os: process.platform,
    arch: process.arch,
    provider: provider.name,
    kvm: await isReadWritable("/dev/kvm"),
    maxConcurrency: concurrency,
    vmSizes: provider.name === "firecracker" ? (Object.keys(FIRECRACKER_SIZES) as FirecrackerVmSize[]) : [],
    version: VERSION,
  };
  console.log(
    `[brevi] provider ${provider.name} (kvm ${capabilities.kvm ? "yes" : "no"}, ${process.platform}/${process.arch}), concurrency ${concurrency}`,
  );

  /** Runs this process has executed since it started; the only source attach.ts has for a run's agentSessionId and retained-disk bookkeeping. */
  const knownRuns = new Map<string, Run>();
  /** Runs currently executing: an aborted execution's entry lives here until its promise settles, not until the host acks it (see claimedLeases below for that). */
  const activeRuns = new Map<string, ActiveRun>();
  /**
   * Leases this worker still holds, independent of whether the run behind
   * them is still executing: added the moment a dispatch is accepted,
   * removed only once the host's run-complete-ack for that lease arrives
   * (handleRunCompleteAck). A run that finishes while the socket is down
   * would otherwise vanish from activeRuns before the host ever sees its
   * completion, so the next register frame would omit its lease and the
   * host would strand it as a disconnect failure; keeping the claim open
   * here is what lets a reconnect still list it and replay the buffered
   * run-patch/run-artifact/run-complete frames against a lease the host
   * still considers valid.
   */
  const claimedLeases = new Map<string, RunLease>();
  /**
   * Completion frames handed to the socket but not yet acknowledged, keyed by
   * lease. socket.send() accepting a frame is not the host receiving it, so a
   * drop in that window would otherwise lose the completion permanently: the
   * lease stays claimed, the reconnect re-advertises it, the host keeps it,
   * and nothing ever resends. Replayed on every registration, cleared by the
   * host's run-complete-ack.
   */
  const unacknowledgedCompletions = new Map<string, WorkerMessage>();
  /**
   * Discards still tearing down a run's sandbox and workspace, keyed by run.
   * A retry discards the previous attempt's retained sandbox and redispatches
   * the same run id immediately, and the host has no acknowledgement to wait
   * for, so without this the teardown's recursive remove of
   * WORKSPACES_DIR/<runId> can land in the middle of the retry's checkout into
   * that same path. A dispatch for a run waits for its own discard first.
   */
  const activeDiscards = new Map<string, Promise<void>>();
  // Set once a shutdown signal lands: new dispatches are refused from that
  // point on, so the set of runs this worker is still finishing only ever
  // shrinks during shutdown.
  let shuttingDown = false;
  // The operator's state for this worker, as the host reports it (on every
  // registration, on every heartbeat-ack, and pushed when it changes).
  // Draining refuses new dispatches while the runs already in flight finish
  // and report normally, so a machine being decommissioned empties itself.
  let draining = false;
  /** Whether the host has reported this worker's state at least once, so the first report is not mistaken for a transition. */
  let stateReported = false;

  // A restart forgets every retained disk it can no longer identify (see
  // knownRuns above): nothing points at them anymore from this process's
  // perspective, so anything left under WORKSPACES_DIR from before this
  // boot is stale scratch, a crash, or a sandbox this worker can no longer
  // resume into. Kept simple on purpose; a later fleet iteration can persist
  // enough state to survive a restart with retention intact.
  await sweepStaleWorkspaces(knownRuns);

  let connection: WorkerConnection;
  let attachSessions: AttachSessions;

  const handleDispatch = (dispatch: DispatchMessage): void => {
    const { lease, kind, run, config: dispatchedConfig, prompts } = dispatch;
    if (shuttingDown) {
      connection.send({ type: "dispatch-rejected", leaseId: lease.id, runId: run.id, reason: "worker is shutting down" });
      return;
    }
    if (draining) {
      connection.send({ type: "dispatch-rejected", leaseId: lease.id, runId: run.id, reason: "worker is draining" });
      return;
    }
    if (activeRuns.size >= concurrency) {
      connection.send({
        type: "dispatch-rejected",
        leaseId: lease.id,
        runId: run.id,
        reason: `worker at capacity (${concurrency} concurrent run(s))`,
      });
      return;
    }
    if (activeRuns.has(run.id)) {
      connection.send({
        type: "dispatch-rejected",
        leaseId: lease.id,
        runId: run.id,
        reason: `a lease for run ${run.id} is already active on this worker`,
      });
      return;
    }

    connection.send({ type: "dispatch-accepted", leaseId: lease.id, runId: run.id });
    claimedLeases.set(lease.id, lease);

    // A worker's provider and image paths are local to its machine: the
    // dispatched config's sandbox.* is the host's view (or blank, since the
    // host never boots a sandbox itself), never what this worker executes
    // with.
    const runConfig: BreviConfig = {
      ...dispatchedConfig,
      sandbox: { ...dispatchedConfig.sandbox, provider: config.sandbox.provider, firecracker: config.sandbox.firecracker },
    };

    const abort = new AbortController();
    const reporter = new RunReporter({ run, leaseId: lease.id, connection });
    knownRuns.set(run.id, run);

    const linear = new LinearService(runConfig, {
      recover: async () => false,
      rejected: () => {},
    });

    const ctx: RunContext = {
      runId: run.id,
      config: runConfig,
      store: reporter,
      recalledMemories: prompts.memories,
      recordMemories: async (repo, learned) => {
        connection.send({ type: "run-memories", leaseId: lease.id, runId: run.id, repo, ident: run.ticket.identifier, learned });
      },
      prompts: { prDescription: prompts.prDescription, recordMemories: prompts.recordMemories },
      provider,
      linear,
      signal: abort.signal,
    };

    console.log(`[brevi] executing ${kind} for run ${run.id} (${run.ticket.identifier})`);
    // Kept as a promise (not fired with `void`) so shutdown can retain and
    // await it instead of abandoning whatever sandbox/agent child process is
    // still running underneath it; see the shutdown ordering comment below.
    const execution = (async () => {
      try {
        // A retry discards the previous attempt's sandbox and redispatches the
        // same run id straight away, and the host waits for no acknowledgement
        // in between. Letting the teardown's recursive remove of this run's
        // workspace run alongside the checkout that recreates it would delete
        // the retry's own files, so wait it out first.
        const discard = activeDiscards.get(run.id);
        if (discard) {
          console.log(`[brevi] run ${run.id} waiting for its previous sandbox to be discarded`);
          await discard;
        }
        await (kind === "follow-up" ? executeFollowUp : executeRun)(ctx);
      } catch (error) {
        console.error(`[brevi] run ${run.id} crashed: ${errorMessage(error)}`);
        // Reaching here means the failure escaped the execution's own error
        // handling, so nothing has recorded a reason. The completion frame is
        // built from the reporter below and would carry a bare "failed" with
        // no error text and an attempt left open, which is what the user sees
        // in the dashboard. Record both before that frame is built.
        if (!isTerminal(reporter.run.status)) {
          try {
            await reporter.endAttempt(run.id, { error: errorMessage(error) });
            await reporter.setStatus(run.id, "failed", {
              error: errorMessage(error),
              finishedAt: new Date().toISOString(),
            });
          } catch (reportError) {
            console.error(`[brevi] could not record run ${run.id}'s failure: ${errorMessage(reportError)}`);
          }
        }
      } finally {
        activeRuns.delete(run.id);
        knownRuns.set(run.id, reporter.run);
        console.log(`[brevi] run ${run.id} finished: ${reporter.run.status}`);
        const completion = runCompleteFor(lease.id, run.id, reporter);
        unacknowledgedCompletions.set(lease.id, completion);
        connection.send(completion);
      }
    })();
    activeRuns.set(run.id, { lease, abort, reporter, execution });
  };

  const handleCancel = (message: CancelMessage): void => {
    const active = activeRuns.get(message.runId);
    // A cancel for a lease this worker no longer holds (already finished, or
    // superseded by a later dispatch of the same run) is stale; ignore it.
    if (!active || active.lease.id !== message.leaseId) return;
    active.abort.abort();
  };

  const handleDiscard = (message: DiscardMessage): Promise<void> => {
    knownRuns.delete(message.runId);
    const teardown = (async () => {
      await provider.discard(message.runId).catch(() => undefined);
      await rm(join(WORKSPACES_DIR, message.runId), { recursive: true, force: true }).catch(() => undefined);
    })().finally(() => {
      if (activeDiscards.get(message.runId) === teardown) activeDiscards.delete(message.runId);
    });
    activeDiscards.set(message.runId, teardown);
    return teardown;
  };

  /** The host applied this run's completion and released the lease; a run this worker no longer claims (already dropped, or from a previous process) is ignored rather than treated as an error. */
  const handleRunCompleteAck = (message: RunCompleteAckMessage): void => {
    claimedLeases.delete(message.leaseId);
    unacknowledgedCompletions.delete(message.leaseId);
  };

  /**
   * Settles once this daemon has stopped: resolved by a clean SIGINT/SIGTERM
   * shutdown, rejected when the host revoked this worker's enrollment, since
   * a revoked worker exiting is a failure the caller should surface (nothing
   * it reports would be accepted any more).
   */
  let resolveStopped: () => void = () => {};
  let rejectStopped: (error: Error) => void = () => {};
  const stopped = new Promise<void>((resolve, reject) => {
    resolveStopped = resolve;
    rejectStopped = reject;
  });

  /**
   * The one graceful stop, shared by the signal handlers and by a revoke.
   * Its ordering is load-bearing (see the numbered comment inside): the same
   * sequence has to run whichever of the two started it, because a revoked
   * worker still has sandboxes and agent child processes to tear down.
   */
  const shutdown = (failure?: Error): void => {
    shuttingDown = true;
    void (async () => {
      // Ordering matters here, in this order, because it is the difference
      // between a clean stop and orphaned microVMs:
      //   1. stop accepting dispatches (done above, via shuttingDown)
      //   2. abort every active run, so its sandbox and agent child
      //      process are actually told to stop instead of being abandoned
      //   3. await those executions, bounded by a deadline, so their
      //      terminal reporting (patches plus run-complete) is produced
      //      and hits the connection's outbound queue
      //   4. wait for that queue to actually drain to the socket
      //   5. only now close attach sessions and the connection
      // Closing the socket before step 4 would drop a run's final
      // run-complete on the floor forever (the host has no idea the run
      // ended); destroying sandboxes before step 2 or skipping the wait in
      // step 3 leaves Firecracker VMs (or process-provider children)
      // running with nothing left to report their exit.
      for (const active of activeRuns.values()) active.abort.abort();
      const deadline = Date.now() + SHUTDOWN_DEADLINE_MS;
      const executions = [...activeRuns.values()].map((active) => active.execution);
      const settled = await withDeadline(Promise.allSettled(executions), deadline - Date.now());
      if (settled === "timeout") {
        console.error(
          `[brevi] shutdown deadline (${SHUTDOWN_DEADLINE_MS}ms) reached with ${activeRuns.size} run(s) still finishing; giving up on a clean stop`,
        );
      }
      const drained = await connection.drain(Math.max(0, deadline - Date.now()));
      if (!drained) {
        console.error(
          `[brevi] outbound connection did not drain before the shutdown deadline (${connection.pendingCount()} message(s) still queued); some final reporting may not have reached the host`,
        );
      }
      attachSessions.closeAll();
      connection.close();
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      if (failure) rejectStopped(failure);
      else resolveStopped();
    })();
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      // An operator hitting Ctrl-C twice wants out now, not a status
      // update; a hung sandbox teardown must never be able to trap them.
      console.log(`[brevi] received ${signal} again; exiting immediately`);
      process.exit(1);
    }
    console.log(`[brevi] received ${signal}, shutting down...`);
    shutdown();
  };
  const onSigint = (): void => onSignal("SIGINT");
  const onSigterm = (): void => onSignal("SIGTERM");

  connection = connectToHost({
    hostUrl: options.hostUrl,
    token: options.token,
    enrollment,
    name,
    capabilities,
    activeLeases: () => [...claimedLeases.values()],
    unacknowledged: () => [...unacknowledgedCompletions.values()],
    // The pairing token was just redeemed for this credential, and this is
    // the only copy of it that exists: everything the connection does next
    // waits on this write landing.
    onEnrolled: (record) => saveEnrollment(record),
    onState: (state: WorkerState) => {
      const next = state === "draining";
      // The state arrives on every registration and heartbeat-ack too, so only
      // an actual change is worth a line. The first report is not a change: it
      // is what the host already thought of this worker, and it only deserves
      // a line when it is "draining", which would otherwise silently explain
      // why nothing is ever dispatched here.
      const first = !stateReported;
      stateReported = true;
      if (!first && next === draining) return;
      draining = next;
      if (first) {
        if (next) console.log("[brevi] the host has this worker draining: it accepts no new dispatches until re-enabled");
        return;
      }
      console.log(
        next
          ? "[brevi] the host set this worker to draining: finishing the runs in flight, accepting no new dispatches"
          : "[brevi] the host set this worker back to active: accepting dispatches again",
      );
    },
    onRevoked: (reason) => {
      if (shuttingDown) return;
      void (async () => {
        // The credential is dead on the host, so keeping it would only mean
        // being refused on every later start. Forget it first, then stop the
        // same way a SIGTERM would, so in-flight sandboxes still come down.
        await clearEnrollment().catch((error: unknown) => {
          console.error(`[brevi] could not remove the stored credential: ${errorMessage(error)}`);
        });
        shutdown(
          new Error(
            `this worker's enrollment was revoked by the host (${reason}). Enroll this machine again with a fresh pairing token from Configuration > Workers.`,
          ),
        );
      })();
    },
  });

  attachSessions = createAttachSessions({
    provider,
    getRun: (runId) => knownRuns.get(runId),
    send: (message) => connection.send(message),
  });

  connection.onHostMessage((message) => {
    switch (message.type) {
      case "dispatch":
        handleDispatch(message);
        return;
      case "cancel":
        handleCancel(message);
        return;
      case "run-complete-ack":
        handleRunCompleteAck(message);
        return;
      case "discard":
        void handleDiscard(message);
        return;
      case "heartbeat-ack":
        return; // liveness (and this worker's state, applied in connection.ts); nothing else to react to
      case "worker-state":
        return; // applied in connection.ts, via onState
      case "attach-open":
        void attachSessions.open(message);
        return;
      case "attach-input":
        attachSessions.input(message.attachId, message.data);
        return;
      case "attach-resize":
        attachSessions.resize(message.attachId, message.cols, message.rows);
        return;
      case "attach-close":
        attachSessions.close(message.attachId);
        return;
      // registered/rejected/revoked are handled inside connection.ts itself.
      default:
        return;
    }
  });

  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  console.log(
    enrollment
      ? `[brevi] connecting to ${options.hostUrl} as worker "${name}"...`
      : `[brevi] enrolling with ${options.hostUrl} as worker "${name}"...`,
  );

  await stopped;
}

/**
 * Removes leftover workspace directories this process has no record of.
 * Ported from the orchestrator's old #sweepWorkspaces, simplified for a
 * worker: the host, not this process, knows which runs are still active or
 * within their retention window, and a freshly started worker starts with
 * an empty `knownRuns` map, so on boot this just clears every directory
 * under WORKSPACES_DIR. Once a dispatch or an attach teaches this process
 * about a run, its directory is safe until the process exits again.
 */
async function sweepStaleWorkspaces(knownRuns: ReadonlyMap<string, Run>): Promise<void> {
  let entries;
  try {
    entries = await readdir(WORKSPACES_DIR, { withFileTypes: true });
  } catch {
    return; // nothing to sweep
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || knownRuns.has(entry.name)) continue;
    console.log(`[brevi] removed leftover sandbox workspace ${entry.name}`);
    await rm(join(WORKSPACES_DIR, entry.name), { recursive: true, force: true }).catch(() => undefined);
  }
}
