import { EventEmitter } from "node:events";
import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { basename, dirname } from "node:path";
import type { WebSocket } from "ws";
import {
  configSchema,
  CONFIG_PATH,
  changedSecretPaths,
  isPlainObject,
  isUnsafeConfigKey,
  SETTINGS_SECRET_PATHS,
  MASKED_SECRET,
  mergeConfigPatch,
  needsRestart,
  readConfigPath,
  redactConfig,
  type BreviConfig,
  type ConnectResponse,
  type CredentialProvider,
  type CredentialResult,
  type CredentialsUpdateRequest,
  type CredentialsUpdateResponse,
  type DevicePollResponse,
  type DispatchPrompts,
  type FleetDemandResponse,
  type FleetResponse,
  type GithubRepo,
  type LinearProject,
  type LinearStatus,
  type MemoriesResponse,
  type PairingTokenResponse,
  type PrState,
  type PrStatusResponse,
  type ConfigPatch,
  type R2ConnectResponse,
  type R2Status,
  type ResumeRunResponse,
  type Run,
  type RunEvent,
  type SettingsUpdateResponse,
  type Ticket,
  type WorkerState,
  type WorkerView,
  urlHost,
} from "@brevi/shared";
import { saveConfig, serializeConfig } from "./config.js";
import {
  discoverAnthropicCredential,
  discoverCodexCredential,
  discoverGithubToken,
  discoverXaiCredential,
  exchangeLinearCode,
  githubClientId,
  hostedApiReachable,
  linearOauthApp,
  LinearRefreshError,
  pollGithubDeviceFlow,
  refreshLinearToken,
  startGithubDeviceFlow,
  startLinearOauth,
  type GithubDeviceSession,
  type LinearOauthSession,
  type LinearTokens,
} from "./connect.js";
import {
  validateAnthropicApiKey,
  validateAnthropicCredential,
  validateCodexApiKey,
  validateCodexChatgptAuth,
  validateGithubToken,
  validateLinearApiKey,
  validateGrokAuth,
  validateXaiApiKey,
} from "./credentials.js";
import { FleetStore, sanitizeWorkerName } from "./fleet.js";
import { branchNameFor, fetchPrStatus, fetchPullRequestState, findPullRequestForBranch, listRepos } from "./github.js";
import { agentProvider, probeAgentLimit } from "./limits.js";
import { isLinearAuthError, LinearService, type LinearAuthHooks } from "./linear.js";
import { memoryKeyFor, MemoryStore, selectMemories } from "./memory.js";
import { checkWrangler, DEFAULT_EVIDENCE_BUCKET, provisionBucket, startWranglerLogin } from "./r2.js";
import { isSafePathSegment } from "./safepath.js";
import { ACTIVE_STATUSES, RunStore, isTerminal } from "./state.js";
import {
  LocalWorkerRefusalError,
  WorkerRegistry,
  type AttachSession,
  type AttachSessionOptions,
  type CancelOutcome,
  type DispatchOutcome,
  type DispatchRequest,
  type RestoredLease,
} from "./workers.js";

/**
 * When a run's most recent attempt began. The run's own `startedAt` covers
 * its first attempt; a retry's attempt is newer than that, so the latest
 * attempt's own `startedAt` wins whenever there is one.
 */
export function attemptStartOf(run: Pick<Run, "attempts" | "startedAt" | "createdAt">): string {
  return run.attempts.at(-1)?.startedAt ?? run.startedAt ?? run.createdAt;
}

/**
 * Whether a pull request found on an interrupted run's branch is proof that
 * *this attempt* produced it, and may therefore complete the run instead of
 * requeueing it. See Orchestrator#adoptedPullRequest for why the bar is here;
 * exported so the rule can be pinned down directly in tests.
 */
export function adoptableFromAttempt(options: {
  kind: "implementation" | "follow-up";
  /** ISO time the interrupted attempt began; see attemptStartOf. */
  attemptStartedAt: string;
  pr: { state: PrState; createdAt: string };
}): boolean {
  // A follow-up runs precisely *because* a pull request already exists, so
  // finding one says nothing about whether this attempt rebased or addressed
  // any feedback before its worker vanished.
  if (options.kind === "follow-up") return false;
  // A closed (never merged) pull request is not this run's work to keep.
  if (options.pr.state === "closed") return false;
  const startedAt = Date.parse(options.attemptStartedAt);
  const createdAt = Date.parse(options.pr.createdAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(createdAt)) return false;
  // Opening the pull request is the last thing a run does, and it is what
  // makes the run externally visible, so a PR that did not exist when this
  // attempt began and does now is exactly the evidence that the dead worker
  // got to the end. One that predates the attempt is not: `run.prUrl`
  // survives a requeue by design (see Run.prUrl), and the branch a ticket
  // maps to is stable across runs, so a retry and a follow-up both find a
  // pull request they did nothing to produce.
  return createdAt >= startedAt;
}

/** What #recoverRuns decides to do with each run it finds on disk after a restart. */
export interface RunRecoveryPlan {
  /** Runs a restored lease still covers: left alone, their worker may reconnect and resume reporting. */
  leased: RestoredLease[];
  /** Run ids to put back on the dispatch queue, in FIFO order. */
  queue: string[];
  /** Run ids that were mid-execution with nothing left holding them, so they take the interruption path. */
  interrupted: string[];
}

/**
 * Split the runs a restarted host finds still in progress into the three
 * things that can be done with them, given the leases the fleet registry just
 * restored. Exported so the one rule that matters here can be pinned down in
 * tests without standing up an Orchestrator.
 *
 * That rule: a restored lease decides a run's fate before its recorded status
 * does. A run can be persisted as "queued" and still hold a live lease,
 * because dispatch() issues the lease while the run only leaves "queued" when
 * the worker's first run-patch lands, and the host can stop in between.
 * Queueing such a run again would hand the same work to a second worker while
 * the first is still executing it, or hand it out twice if the first finished
 * while the host was down.
 */
export function planRunRecovery(
  pending: Pick<Run, "id" | "status" | "queuedAt" | "createdAt">[],
  restored: RestoredLease[],
): RunRecoveryPlan {
  const leaseByRun = new Map(restored.map((lease) => [lease.runId, lease]));
  const leased = pending.flatMap((run) => {
    const lease = leaseByRun.get(run.id);
    return lease ? [lease] : [];
  });
  // Ascending queuedAt, matching the FIFO order #queue and the dashboard's
  // sidebar both expect; store.list() itself returns newest first.
  const queue = pending
    .filter((run) => run.status === "queued" && !leaseByRun.has(run.id))
    .sort((a, b) => (a.queuedAt ?? a.createdAt).localeCompare(b.queuedAt ?? b.createdAt))
    .map((run) => run.id);
  const interrupted = pending
    .filter((run) => run.status !== "queued" && !leaseByRun.has(run.id))
    .map((run) => run.id);
  return { leased, queue, interrupted };
}

/** Error with an HTTP-mappable code, thrown by orchestrator commands. */
export class OrchestratorError extends Error {
  constructor(
    readonly code: "not-found" | "conflict" | "invalid" | "gone",
    message: string,
  ) {
    super(message);
    this.name = "OrchestratorError";
  }
}

interface OrchestratorEvents {
  tickets: [Ticket[]];
  config: [BreviConfig];
  "linear-status": [LinearStatus];
  workers: [WorkerView[]];
}

/**
 * Refresh proactively this long before the recorded expiry so polling never
 * runs into a dead token: fetchEligibleTickets shouldn't have to hit a 401
 * just to learn a refresh was due.
 */
const LINEAR_REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * Backoff between retries of a transiently failing token refresh (network,
 * 5xx, rate limit): starts at the base, doubles per consecutive failure,
 * caps at the max. A Retry-After from a 429 extends the wait when longer.
 */
const LINEAR_REFRESH_BACKOFF_BASE_MS = 60_000;
const LINEAR_REFRESH_BACKOFF_MAX_MS = 15 * 60_000;

/** How often the orchestrator re-checks the PR state of recent runs with a live PR. */
const PR_POLL_INTERVAL_MS = 120_000;
/** Only this many of the newest eligible runs are checked per cycle. */
const PR_POLL_RECENT_RUNS = 20;
/** Delay before retrying a failed retained-sandbox reap (the disk holds credential material). */
const REAP_RETRY_MS = 60_000;
/** How long config.json has to stay untouched before a hand edit is reloaded. */
const CONFIG_RELOAD_DEBOUNCE_MS = 250;

/**
 * The host's first non-internal IPv4, for the pairing command printed when
 * the listener that will receive the worker's connection binds a wildcard
 * address ("0.0.0.0", "::", ...): a worker on another machine can't dial that
 * address directly and reach anything, so a concrete LAN address is guessed
 * instead. Best-effort; a machine with no such interface (unusual, but
 * possible in a container) falls back to localhost, same as if this returned
 * nothing.
 */
function guessLanAddress(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
}

/** Bind addresses that mean "every interface"; see dialableHost. */
const WILDCARD_BIND_ADDRESSES = ["0.0.0.0", "::", "::0", "0:0:0:0:0:0:0:0"];

/**
 * Map a listener's bind address to the host worth printing in the pairing
 * command, and whether that host is actually reachable from another machine.
 * A wildcard bind accepts connections from the network, but a worker can't
 * dial the wildcard address itself, so a LAN address is guessed and, when
 * found, is genuinely reachable. A loopback-only bind accepts nothing but
 * this machine, so "localhost" is printed and marked unreachable rather than
 * inventing an address nothing will answer on. Anything else (a real
 * hostname or IP the operator set) is already dialable and used as-is;
 * urlHost is reused here for that case and for the loopback mapping so the
 * bracket-a-bare-IPv6-literal rule lives in one place.
 */
function dialableHost(bindHost: string): { host: string; remote: boolean } {
  if (WILDCARD_BIND_ADDRESSES.includes(bindHost)) {
    const lan = guessLanAddress();
    return lan ? { host: lan, remote: true } : { host: "localhost", remote: false };
  }
  const mapped = urlHost(bindHost);
  return { host: mapped, remote: mapped !== "localhost" };
}

/**
/**
 * Write a dotted path into a plain-object tree, creating missing levels.
 * Only used for the fixed credential paths, which contain no dots.
 */
function writeConfigPath(target: object, path: string, value: unknown): void {
  const segments = path.split(".");
  const leaf = segments.pop();
  if (leaf === undefined || segments.some(isUnsafeConfigKey) || isUnsafeConfigKey(leaf)) return;
  let cursor = target as Record<string, unknown>;
  for (const segment of segments) {
    const next = cursor[segment];
    if (!isPlainObject(next)) cursor[segment] = {};
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[leaf] = value;
}

function assignInPlace<T extends object>(target: T, source: T): void {
  const to = target as Record<string, unknown>;
  const from = source as Record<string, unknown>;
  for (const key of Object.keys(to)) {
    if (!Object.hasOwn(from, key)) delete to[key];
  }
  for (const [key, value] of Object.entries(from)) {
    // `to[key] = value` on "__proto__" reassigns the prototype instead of
    // adding a property. Every source reaching this today is schema output,
    // which drops such keys, but the guard belongs on the write itself rather
    // than on an assumption about every present and future caller.
    if (isUnsafeConfigKey(key)) continue;
    const current = to[key];
    if (isPlainObject(value) && isPlainObject(current)) assignInPlace(current, value);
    else to[key] = value;
  }
}

/**
 * Result of one attempt to refresh the stored Linear OAuth token. "stale"
 * means the credential changed while the refresh was in flight and the
 * response was discarded; the change's own connect/disconnect path is in
 * charge now.
 */
type LinearRefreshOutcome =
  | { ok: true }
  | { ok: false; reason: "stale" }
  | { ok: false; reason: "permanent" | "transient"; detail: string };

/**
 * Ties everything together: polls Linear on an interval, auto-queues eligible
 * tickets, and executes runs FIFO with at most `sandbox.concurrency` in
 * flight (default 1).
 */
export class Orchestrator extends EventEmitter<OrchestratorEvents> {
  readonly store: RunStore;
  readonly config: BreviConfig;
  /** What brevi has learned about each repo, carried across sandboxes. */
  readonly memories: MemoryStore;
  /** Who is enrolled as a worker of this host, and the credentials that prove it. */
  readonly fleet: FleetStore;

  /**
   * What the worker channel's own listener actually bound (see
   * startFleetListener in server.ts), or undefined when config.fleet.host is
   * empty and no such listener exists. Set once at startup via
   * setFleetEndpoint; mintPairingToken prefers it over the dashboard listener
   * because it's the address a worker is meant to dial.
   */
  #fleetEndpoint?: { host: string; port: number };

  /**
   * What the dashboard listener actually bound, recorded once at startup for
   * the same reason the fleet endpoint is. `config.server.host` and
   * `config.server.port` are not a substitute: both are restart-required
   * fields, so `updateSettings` writes an operator's new value into the live
   * config immediately while the socket stays bound where it already was.
   * Pairing off the pending value would print a command naming an address
   * nothing is listening on, and call it remotely reachable.
   */
  #dashboardEndpoint?: { host: string; port: number };

  #configPath: string;
  #linear?: LinearService;
  /** The worker fleet: undefined only before start() runs. */
  #workers?: WorkerRegistry;
  #tickets: Ticket[] = [];
  #queue: string[] = [];
  #pollTimer?: NodeJS.Timeout;
  /** Lazy GitHub PR-state poll for recent runs with a live PR. */
  #prTimer?: NodeJS.Timeout;
  /** In-flight PR-state refresh per run, so bursts share one GitHub request. */
  #prRefreshes = new Map<string, Promise<PrState | null>>();
  /** One pending resume timer per run waiting on a usage-limit reset. */
  #resumeTimers = new Map<string, NodeJS.Timeout>();
  /** Tail of each run's command chain; cancel/retry/follow-up serialize through it so two commands can never act on the same stale snapshot. */
  #runLocks = new Map<string, Promise<void>>();
  /** One pending reap timer per run with a retained sandbox, keyed by run id. */
  #reapTimers = new Map<string, NodeJS.Timeout>();
  /**
   * Runs whose queued execution is a follow-up rather than a fresh
   * implementation attempt. In-memory, but a restart no longer loses it: on
   * boot #recoverRuns re-derives it from the restored leases whose kind is
   * "follow-up". The one gap is a follow-up that was queued but never
   * dispatched before the restart (no lease was ever issued for it), which
   * falls back to a fresh implementation attempt; that's honest, since
   * nothing was ever executed for it to follow up on.
   */
  #followUps = new Set<string>();
  /** #dispatchQueued logs "waiting on fleet capacity" once per stretch of unavailability, not on every attempt. */
  #warnedNoCapacity = false;
  #stopped = false;
  #warnedNoRepo = new Set<string>();
  #githubDevice?: GithubDeviceSession;
  #linearOauth?: LinearOauthSession;
  /** In-flight `wrangler login`, so repeated Connect clicks don't spawn parallel logins. */
  #r2Login?: Promise<unknown>;
  /** Set once the stored Linear credential is confirmed dead; polling is paused until a reconnect clears it. */
  #linearAuthError?: string;
  /** Set while the expired OAuth token can't be refreshed for a transient reason; polling is paused but retries on its own. */
  #linearRefreshFailing?: string;
  /** In-flight token refresh, so a proactive refresh and a reactive one triggered by a failed call never race. */
  #linearRefresh?: Promise<LinearRefreshOutcome>;
  /** Backoff between refresh attempts while the token endpoint keeps failing transiently. */
  #linearRefreshBackoff?: { attempts: number; until: number; detail: string };
  /**
   * Bumped on every user-initiated Linear credential change (connect,
   * reconnect, manual key, disconnect). A refresh captures it when it starts
   * and discards its response when it no longer matches, so a stale response
   * can never restore or overwrite a credential the user changed.
   */
  #linearGeneration = 0;
  /** In-flight poll cycle; poll() piggybacks on it instead of overlapping. */
  #polling?: Promise<void>;
  /** A poll was requested while one was in flight; run one more cycle when it finishes. */
  #pollAgain = false;
  /** Tail of the config write chain; #persistConfig appends so writes never interleave. */
  #configWrite: Promise<unknown> = Promise.resolve();
  /** Tail of the config transaction chain; see #transact. */
  #configTx: Promise<unknown> = Promise.resolve();
  /** Watches config.json for hand edits, so the file stays the source of truth. */
  #configWatcher?: FSWatcher;
  /** Debounce for the watcher above; editors save in several syscalls. */
  #configReloadTimer?: NodeJS.Timeout;
  /** Exact text of the last config brevi itself wrote, so its own writes don't look like hand edits. */
  #lastWritten?: string;
  /** Recovery hooks handed to LinearService so every Linear call shares one refresh path. */
  readonly #linearAuth: LinearAuthHooks = {
    recover: () => this.#recoverLinearAuth(),
    rejected: (detail) => this.#enterLinearAuthError(detail),
  };

  constructor(
    config: BreviConfig,
    store: RunStore = new RunStore(),
    configPath?: string,
    memories: MemoryStore = new MemoryStore(),
    fleet: FleetStore = new FleetStore(),
  ) {
    super();
    this.config = config;
    this.store = store;
    this.memories = memories;
    this.fleet = fleet;
    this.#configPath = configPath ?? CONFIG_PATH;
    if (config.linear.apiKey) this.#linear = new LinearService(config, this.#linearAuth);
  }

  /**
   * What the fleet actually runs on, for the dashboard's health chip: the
   * single provider every connected worker reports, "mixed" when they
   * disagree, "none" when nothing is connected. The host itself never picks
   * a provider, each worker resolves its own. Only connected workers count,
   * since this describes what the fleet can run right now, not what an
   * enrolled machine reported the last time it was up.
   */
  get providerName(): string {
    const providers = new Set(
      (this.#workers?.list() ?? [])
        .filter((worker) => worker.connection === "online")
        .map((worker) => worker.capabilities?.provider)
        .filter((provider): provider is NonNullable<typeof provider> => provider !== undefined),
    );
    if (providers.size === 0) return "none";
    if (providers.size > 1) return "mixed";
    return [...providers][0]!;
  }

  get tickets(): Ticket[] {
    return this.#tickets;
  }

  listRuns(): Run[] {
    return this.store.list();
  }

  /** Every enrolled worker, merged with its live connection state, for the Workers page. */
  listWorkers(): WorkerView[] {
    return this.#workers?.list() ?? [];
  }

  /**
   * Hand a freshly-upgraded `/ws/worker` socket to the fleet registry. A
   * socket that reaches this before `start()` has run has nothing to
   * register with (there is no registry yet), so it is terminated outright
   * rather than buffered for later.
   */
  acceptWorkerSocket(socket: WebSocket, address?: string): void {
    if (!this.#workers) {
      socket.terminate();
      return;
    }
    this.#workers.accept(socket, address);
  }

  /**
   * Tell the orchestrator what the worker channel's own listener actually
   * bound (or that none did), so mintPairingToken can name an address that is
   * genuinely listening. Called once by startOrchestrator after the listener
   * binds (with the real bound port, the way the dashboard port already
   * works).
   */
  setFleetEndpoint(endpoint: { host: string; port: number } | null): void {
    this.#fleetEndpoint = endpoint ?? undefined;
  }

  /** The dashboard listener's real bind address and port; see #dashboardEndpoint. */
  setDashboardEndpoint(endpoint: { host: string; port: number }): void {
    this.#dashboardEndpoint = endpoint;
  }

  /**
   * Mint a pairing token and the ready-to-copy `brevi worker` command for it.
   * The fleet listener is preferred when one is bound, since that's the
   * channel a worker on another machine is meant to dial; the dashboard
   * listener is the fallback, which serves the same worker path for a worker
   * on this machine.
   */
  mintPairingToken(): PairingTokenResponse {
    if (!this.#workers) throw new OrchestratorError("conflict", "the orchestrator is not running yet");
    const { token, expiresAt } = this.#workers.mintPairingToken();
    const { host: dialHost, port, remote } = this.#pairingEndpoint();
    const host = `http://${dialHost}:${port}`;
    return { token, expiresAt, command: `brevi worker --host ${host} --token ${token}`, host, remote };
  }

  /**
   * Bind address and port to print in the pairing command: whichever listener
   * is really serving the worker channel, mapped through dialableHost so the
   * result is something a worker can actually dial (or honestly marked as not
   * remote-reachable when it can't be). Both endpoints are what was bound, not
   * what the config currently says, so a restart-required change saved but not
   * yet applied cannot make this advertise an address nothing answers on. The
   * config is the last resort only for a caller minting before either listener
   * has come up, which the running server never does.
   */
  #pairingEndpoint(): { host: string; port: number; remote: boolean } {
    const endpoint = this.#fleetEndpoint ?? this.#dashboardEndpoint;
    const { host, remote } = dialableHost(endpoint?.host ?? this.config.server.host);
    return { host, port: endpoint?.port ?? this.config.server.port, remote };
  }

  /** The registry refuses renaming the local worker; recast as an OrchestratorError so it maps to a 400, not a 500. */
  async renameWorker(id: string, name: string): Promise<FleetResponse> {
    const clean = sanitizeWorkerName(name);
    if (!clean) throw new OrchestratorError("invalid", "worker name must not be empty");
    let renamed: boolean;
    try {
      renamed = (await this.#workers?.rename(id, clean)) ?? false;
    } catch (error) {
      if (error instanceof LocalWorkerRefusalError) throw new OrchestratorError("invalid", error.message);
      throw error;
    }
    if (!renamed) throw new OrchestratorError("not-found", `no worker ${id}`);
    return { workers: this.listWorkers() };
  }

  /** Drain finishes in-flight runs and accepts nothing new; enable puts a drained worker back in rotation. */
  async setWorkerState(id: string, state: WorkerState): Promise<FleetResponse> {
    if (!(await this.#workers?.setState(id, state))) throw new OrchestratorError("not-found", `no worker ${id}`);
    return { workers: this.listWorkers() };
  }

  /**
   * Revoke: the credential dies and the worker is disconnected at once. The
   * registry refuses this for the local worker (drain instead); recast as an
   * OrchestratorError so it maps to a 400, not a 500.
   */
  async revokeWorker(id: string): Promise<FleetResponse> {
    let revoked: boolean;
    try {
      revoked = (await this.#workers?.revoke(id)) ?? false;
    } catch (error) {
      if (error instanceof LocalWorkerRefusalError) throw new OrchestratorError("invalid", error.message);
      throw error;
    }
    if (!revoked) throw new OrchestratorError("not-found", `no worker ${id}`);
    return { workers: this.listWorkers() };
  }

  /**
   * Mint or refresh the local worker's credential, returned in plaintext for
   * the caller to inject into the child it is about to spawn. Thin
   * delegation to the registry; throws before start() has built one.
   */
  async ensureLocalWorker(name: string): Promise<{ workerId: string; credential: string }> {
    if (!this.#workers) throw new OrchestratorError("conflict", "the orchestrator is not running yet");
    return this.#workers.ensureLocalWorker(name);
  }

  /**
   * Open an interactive attach session on a run's owning worker. Thin
   * delegation: the registry is the one that knows which worker holds the
   * run and how to route its `attach-*` frames, this just exposes that to
   * `WS /ws/runs/:id/attach`.
   */
  openRunAttach(runId: string, options: AttachSessionOptions): AttachSession | undefined {
    return this.#workers?.openAttach(runId, options);
  }

  /**
   * Whether `credential` is this worker's own durable credential, for the one
   * route a worker's supervisor calls over HTTP (see WORKER_DEMAND_PATH).
   * Delegated straight to the registry so there is exactly one comparison of
   * a credential against the fleet store, whether it arrives on the worker
   * channel or on that route.
   */
  authenticateWorker(workerId: string, credential: string): boolean {
    return this.#workers?.authenticate(workerId, credential) ?? false;
  }

  /**
   * See GET WORKER_DEMAND_PATH: queued work across the host plus this one
   * worker's liveness, for the supervisor deciding whether its machine has to
   * be awake. The caller has already been authenticated as `workerId`.
   */
  fleetDemand(workerId: string): FleetDemandResponse {
    return {
      queuedRuns: this.#queue.length,
      activeRuns: this.#workers?.inFlight() ?? 0,
      connectedWorkers: this.listWorkers().filter((worker) => worker.connection === "online").length,
      spareCapacity: this.#workers?.spareCapacity() ?? 0,
      worker: this.#workers?.workerDemand(workerId) ?? {
        id: workerId,
        connected: false,
        state: "draining",
        activeRuns: 0,
        attachSessions: 0,
      },
    };
  }

  getRun(id: string): Run | undefined {
    return this.store.get(id);
  }

  getRunEvents(id: string): Promise<RunEvent[]> {
    return this.store.readEvents(id);
  }

  /** Everything brevi remembers, keyed by repository ("owner/name"). */
  listMemories(): MemoriesResponse {
    return { repos: this.memories.all() };
  }

  /**
   * Drop one memory. A wrong memory is worse than no memory, because every
   * later run in the repo is handed it, so forgetting one is a first-class
   * command rather than a config edit.
   */
  async forgetMemory(repo: string, id: string): Promise<MemoriesResponse> {
    if (!(await this.memories.forget(repo, id))) {
      throw new OrchestratorError("not-found", `no memory ${id} for ${repo}`);
    }
    return this.listMemories();
  }

  /** Forget everything about one repo; the next run there starts cold again. */
  async clearMemories(repo: string): Promise<MemoriesResponse> {
    if (!(await this.memories.clear(repo))) {
      throw new OrchestratorError("not-found", `nothing remembered for ${repo}`);
    }
    return this.listMemories();
  }

  /**
   * Load state, stand up the worker registry, and begin the poll loop. The
   * host never touches a sandbox: every run's compute lives on whichever
   * `brevi worker` dials in and claims it (see workers.ts).
   */
  async start(): Promise<void> {
    await this.store.init();
    await this.memories.init();
    // Enrollment is durable state, not config: which machines may execute
    // this host's runs is loaded from ~/.brevi/fleet.json before the registry
    // that authenticates against it exists.
    await this.fleet.init();

    this.#workers = new WorkerRegistry({
      config: this.config,
      store: this.store,
      memories: this.memories,
      fleet: this.fleet,
      onRunSettled: (runId) => this.#onRunSettled(runId),
      onRunRejected: (runId, reason, kind) => this.#onRunRejected(runId, reason, kind),
      onRunInterrupted: (runId, reason, kind) => void this.#onRunInterrupted(runId, reason, kind),
    });
    this.#workers.on("workers", (workers) => {
      this.emit("workers", workers);
      // A worker connecting (or freeing up) is exactly when a queue that was
      // stuck for lack of capacity can move again.
      this.#dispatchQueued();
    });

    // Take over leases a previous process left behind before any worker
    // reconnects, so a reconnecting worker's runs are recognised rather than
    // treated as orphaned by the recovery pass below.
    const restored = await this.#workers.restore();
    await this.#recoverRuns(restored);

    // Runs left with a retained sandbox from a previous process pick their
    // reaper back up: a window that already passed is reclaimed right away,
    // otherwise a timer is armed for when it ends.
    for (const run of this.store.list()) {
      const retainedUntil = run.sandbox.retainedUntil;
      if (!retainedUntil) continue;
      // Via #maybeReap, not #reap: a cleanup failure must arm the retry
      // timer, not abort startup.
      if (Date.parse(retainedUntil) <= Date.now()) await this.#maybeReap(run.id);
      else this.#scheduleReap(run.id);
    }
    // Runs left waiting on a limit reset by a previous process pick their
    // schedule back up.
    for (const run of this.store.list()) {
      if (run.status === "waiting") this.#scheduleResume(run.id);
    }
    void this.poll();
    this.#armPollTimer();
    this.#watchConfigFile();
    this.#prTimer = setInterval(() => void this.#pollPrStates(), PR_POLL_INTERVAL_MS);
    this.#prTimer.unref();
  }

  /**
   * Reconcile every run that was neither terminal nor waiting when this
   * process last stopped, against the leases WorkerRegistry.restore() just
   * took over. A queued run never had a lease and simply rejoins #queue; a
   * run whose lease survived is left exactly as it is, since its worker may
   * still reconnect and resume reporting on it; everything else was
   * mid-execution with nothing here to show for it, so it takes the same
   * interruption path a live run takes when its worker disappears.
   */
  async #recoverRuns(restored: RestoredLease[]): Promise<void> {
    const pending = this.store.list().filter((run) => !isTerminal(run.status) && run.status !== "waiting");
    const plan = planRunRecovery(pending, restored);

    for (const lease of plan.leased) {
      this.store.appendEvent({
        runId: lease.runId,
        ts: new Date().toISOString(),
        type: "log",
        stream: "system",
        text: "brevi restarted; waiting for this run's worker to reconnect and resume reporting",
      });
      // Only a follow-up's kind needs reconstructing: #followUps is
      // otherwise in-memory bookkeeping the worker itself never echoes
      // back.
      if (lease.kind === "follow-up") this.#followUps.add(lease.runId);
    }

    for (const runId of plan.queue) {
      if (!this.#queue.includes(runId)) this.#queue.push(runId);
    }

    for (const runId of plan.interrupted) {
      await this.#onRunInterrupted(runId, "brevi restarted with no worker executing this run", "implementation");
    }

    this.#dispatchQueued();
  }

  /** True once a Linear API key is configured. */
  get linearConnected(): boolean {
    return this.#linear !== undefined;
  }

  /** Live state of the Linear connector, for the dashboard's Connectors page. */
  get linearStatus(): LinearStatus {
    if (!this.#linear) return { state: "disconnected" };
    if (this.#linearAuthError) return { state: "auth-error", error: this.#linearAuthError };
    if (this.#linearRefreshFailing) {
      return { state: "refresh-failing", error: this.#linearRefreshFailing };
    }
    return { state: "connected" };
  }

  /**
   * Poll for eligible tickets. Never throws; a bad poll must not take the
   * server down. Single-flight: the interval timer, a reconnect, and a repo
   * update can all ask for a poll while one is still running, and
   * overlapping cycles would race on the connector state transitions. A
   * request that lands mid-cycle runs one follow-up cycle instead of a
   * parallel one, so a reconnect during a slow poll still gets its fresh
   * poll.
   */
  poll(): Promise<void> {
    if (this.#polling) {
      this.#pollAgain = true;
      return this.#polling;
    }
    this.#polling = (async () => {
      do {
        this.#pollAgain = false;
        await this.#pollOnce();
      } while (this.#pollAgain && !this.#stopped);
    })().finally(() => {
      this.#polling = undefined;
    });
    return this.#polling;
  }

  /** One poll cycle. */
  async #pollOnce(): Promise<void> {
    if (this.#stopped) return;
    const linear = this.#linear;
    if (!linear) return; // Not connected yet; the dashboard's Connections panel starts us.
    // A previous cycle already confirmed the stored credential is dead; wait
    // for a reconnect from the dashboard instead of hammering Linear.
    if (this.#linearAuthError) return;

    if (this.#isLinearOauthToken()) {
      const parsedExpiry = Date.parse(this.config.linear.tokenExpiresAt);
      if (Number.isFinite(parsedExpiry) && parsedExpiry - Date.now() < LINEAR_REFRESH_MARGIN_MS) {
        const outcome = await this.#refreshLinear();
        if (!outcome.ok) {
          if (outcome.reason === "stale") return;
          if (outcome.reason === "permanent") {
            this.#enterLinearAuthError(outcome.detail);
            return;
          }
          // Transient: within the margin the old token may still work, so
          // carry on and try refreshing again next cycle. Once it has
          // actually expired every request would just 401; surface the
          // paused state instead and wait for a refresh to succeed.
          if (parsedExpiry <= Date.now()) {
            this.#enterLinearRefreshFailing(outcome.detail);
            return;
          }
        }
      }
    }

    let tickets: Ticket[];
    try {
      tickets = await linear.fetchEligibleTickets();
    } catch (error) {
      // Auth failures were already handled inside the service's recovery
      // wrapper (refresh, one retry, connector state transition and its
      // single log line), so only ordinary transient failures are worth a
      // line here.
      if (!isLinearAuthError(error)) {
        console.error(`[brevi] linear poll failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    this.#tickets = tickets;
    this.emit("tickets", tickets);
    for (const ticket of tickets) {
      try {
        await this.#maybeAutoQueue(ticket);
      } catch (error) {
        console.error(`[brevi] failed to queue ${ticket.identifier}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * One lazy PR-state cycle: re-check the newest runs whose PR has not yet
   * merged or closed (whatever the run's own status; a follow-up attempt
   * keeps its PR). Sequential on purpose; this is background housekeeping,
   * not a hot path.
   */
  async #pollPrStates(): Promise<void> {
    if (this.#stopped || !this.config.github.token) return;
    const candidates = this.store
      .list()
      .filter((run) => run.prUrl !== undefined && run.prState !== "merged" && run.prState !== "closed")
      .slice(0, PR_POLL_RECENT_RUNS);
    for (const run of candidates) {
      if (this.#stopped) return;
      await this.refreshPrState(run.id);
    }
  }

  /**
   * Refresh one run's PR state from GitHub, persist it when it changed (the
   * run-updated broadcast streams it to the dashboard), and return the live
   * state, or null when it could not be verified (no PR, no token, or the
   * fetch failed; the last stored state is kept). Single-flight per run and
   * never throws.
   */
  refreshPrState(runId: string): Promise<PrState | null> {
    const inFlight = this.#prRefreshes.get(runId);
    if (inFlight) return inFlight;
    const pending = (async () => {
      const run = this.store.get(runId);
      const prUrl = run?.prUrl;
      const token = this.config.github.token;
      if (!prUrl || !token) return null;
      const state = await fetchPullRequestState(prUrl, token);
      if (state !== null && state !== this.store.get(runId)?.prState) {
        await this.store.update(runId, { prState: state });
      }
      return state;
    })()
      .catch((error: unknown): null => {
        console.error(`[brevi] PR state refresh for ${runId} failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      })
      .finally(() => {
        this.#prRefreshes.delete(runId);
      });
    this.#prRefreshes.set(runId, pending);
    return pending;
  }

  /** Manually queue a ticket from the dashboard. */
  async queueTicket(ticketId: string): Promise<Run> {
    const ticket = this.#tickets.find((t) => t.id === ticketId);
    if (!ticket) throw new OrchestratorError("not-found", `no eligible ticket with id ${ticketId}`);
    if (!ticket.repo) {
      throw new OrchestratorError(
        "invalid",
        `ticket ${ticket.identifier} has no repo mapping: add a "repo:<key>" label or map its Linear project`,
      );
    }
    if (!this.config.github.token) {
      throw new OrchestratorError(
        "invalid",
        "GitHub is not connected: add a token in the dashboard's Connections panel before running tickets",
      );
    }
    if (this.#activeOrQueuedRun(ticket.id)) {
      throw new OrchestratorError("conflict", `ticket ${ticket.identifier} already has an active run`);
    }
    return this.#enqueue(ticket);
  }

  /**
   * Validate and apply credential changes from the dashboard. Each provided key
   * is checked against its provider; valid keys are applied and persisted even
   * when another key in the same request fails. Setting a key to "" disconnects
   * that provider without validation.
   */
  async updateCredentials(request: CredentialsUpdateRequest): Promise<CredentialsUpdateResponse> {
    const results: CredentialsUpdateResponse["results"] = {};
    let linearChanged = false;

    const apply = async (
      value: string | undefined,
      validate: (key: string) => Promise<CredentialResult>,
      set: (key: string) => void,
    ): Promise<CredentialResult | undefined> => {
      if (value === undefined) return undefined;
      const trimmed = value.trim();
      if (trimmed === "") {
        set("");
        return { ok: true, detail: "Disconnected" };
      }
      const result = await validate(trimmed);
      if (result.ok) set(trimmed);
      return result;
    };

    const [linear, github, anthropic, codex, grok] = await Promise.all([
      apply(request.linearApiKey, validateLinearApiKey, (key) => {
        this.config.linear.apiKey = key;
        // A manually pasted key (or a disconnect) replaces any OAuth grant;
        // the stale refresh token/expiry would otherwise outlive the key
        // they belonged to.
        this.config.linear.refreshToken = "";
        this.config.linear.tokenExpiresAt = "";
        // Applied here rather than after the save: an in-flight refresh must
        // see the generation bump before it can write stale tokens back.
        this.#resetLinearConnection();
        linearChanged = true;
      }),
      apply(request.githubToken, validateGithubToken, (key) => {
        this.config.github.token = key;
      }),
      apply(request.anthropicApiKey, validateAnthropicApiKey, (key) => {
        this.config.agent.anthropicApiKey = key;
        // A manual key (or a disconnect) replaces any host-discovered login.
        this.config.agent.claudeCodeOauthToken = "";
      }),
      apply(request.codexApiKey, validateCodexApiKey, (key) => {
        this.config.agent.codexApiKey = key;
        // A manual key (or a disconnect) replaces any host-discovered login.
        this.config.agent.codexAuthJson = "";
      }),
      apply(request.xaiApiKey, validateXaiApiKey, (key) => {
        this.config.agent.xaiApiKey = key;
        // A manual key (or a disconnect) replaces any host-discovered login.
        this.config.agent.grokAuthJson = "";
      }),
    ]);
    if (linear) results.linear = linear;
    if (github) results.github = github;
    if (anthropic) results.anthropic = anthropic;
    if (codex) results.codex = codex;
    if (grok) results.grok = grok;

    const anyApplied = Object.values(results).some((r) => r.ok);
    if (anyApplied) {
      await this.#persistConfig();
      this.emit("config", redactConfig(this.config));
    }
    if (linearChanged) {
      this.emit("linear-status", this.linearStatus);
      if (this.#linear) {
        void this.poll();
      } else {
        this.#tickets = [];
        this.emit("tickets", this.#tickets);
      }
    }
    return { results, config: redactConfig(this.config) };
  }

  /** Persist a credential mutation and hot-apply it. */
  async #saveCredential(set: () => void, linearChanged = false): Promise<void> {
    set();
    // Applied before the save so an in-flight refresh can't write a stale
    // grant over the one just set.
    if (linearChanged) this.#resetLinearConnection();
    await this.#persistConfig();
    this.emit("config", redactConfig(this.config));
    if (linearChanged) {
      this.emit("linear-status", this.linearStatus);
      if (this.#linear) void this.poll();
    }
  }

  /**
   * One-click connect: try host discovery / OAuth flows for a provider.
   * Falls back to "manual" (dashboard shows the key input) with a reason.
   */
  async connectProvider(
    provider: CredentialProvider,
    serverUrl: string,
  ): Promise<ConnectResponse> {
    switch (provider) {
      case "github": {
        const discovered = await discoverGithubToken();
        if (discovered) {
          const result = await validateGithubToken(discovered.value);
          if (result.ok) {
            await this.#saveCredential(() => {
              this.config.github.token = discovered.value;
            });
            return {
              status: "connected",
              provider,
              detail: `${result.detail} (via ${discovered.source})`,
              config: redactConfig(this.config),
            };
          }
        }
        const clientId = githubClientId(this.config);
        const deviceSource = clientId
          ? { clientId }
          : (await hostedApiReachable(this.config.connect.apiBase))
            ? { apiBase: this.config.connect.apiBase }
            : null;
        if (deviceSource) {
          const session = await startGithubDeviceFlow(deviceSource);
          this.#githubDevice = session;
          return {
            status: "device",
            provider,
            userCode: session.userCode,
            verificationUri: session.verificationUri,
            interval: session.interval,
            expiresIn: Math.floor((session.expiresAt - Date.now()) / 1000),
          };
        }
        return {
          status: "manual",
          provider,
          reason:
            "No GitHub CLI login found and the brevi connect service is unreachable. Run `gh auth login` and connect again, or paste a token.",
        };
      }
      case "linear": {
        const app = linearOauthApp(this.config);
        if (app) {
          const { session, url } = startLinearOauth({ app, serverUrl });
          this.#linearOauth = session;
          return { status: "redirect", provider, url };
        }
        if (await hostedApiReachable(this.config.connect.apiBase)) {
          const { session, url } = startLinearOauth({
            apiBase: this.config.connect.apiBase,
            // From the URL the caller bound, not config.server.port: the port
            // is editable from the dashboard and only takes effect on restart,
            // so the config can name a port nothing is listening on. The
            // hosted backend redirects the callback to whatever it is told.
            port: Number(new URL(serverUrl).port) || this.config.server.port,
          });
          this.#linearOauth = session;
          return { status: "redirect", provider, url };
        }
        return {
          status: "manual",
          provider,
          reason:
            "The brevi connect service is unreachable and no personal OAuth app is configured (connect.linearClientId/Secret). Paste a personal API key instead.",
        };
      }
      case "anthropic": {
        const found = await discoverAnthropicCredential();
        if (!found) {
          return {
            status: "manual",
            provider,
            reason:
              "No Anthropic credential found on this machine (checked ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, and the Claude Code login). Paste an API key instead.",
          };
        }
        const result = await validateAnthropicCredential(
          found.value,
          found.kind === "oauth" ? "oauth" : "api-key",
        );
        if (!result.ok) {
          return {
            status: "manual",
            provider,
            reason: `Found a credential from ${found.source}, but it failed: ${result.detail}`,
          };
        }
        await this.#saveCredential(() => {
          if (found.kind === "oauth") this.config.agent.claudeCodeOauthToken = found.value;
          else this.config.agent.anthropicApiKey = found.value;
        });
        return {
          status: "connected",
          provider,
          detail: `${result.detail} (from ${found.source})`,
          config: redactConfig(this.config),
        };
      }
      case "codex": {
        const found = await discoverCodexCredential();
        if (!found) {
          return {
            status: "manual",
            provider,
            reason:
              "No Codex credential found on this machine (checked OPENAI_API_KEY and ~/.codex/auth.json). Log in with `codex login` and connect again, or paste an OpenAI API key.",
          };
        }
        const result =
          found.kind === "chatgpt"
            ? validateCodexChatgptAuth(found.value)
            : await validateCodexApiKey(found.value);
        if (!result.ok) {
          return {
            status: "manual",
            provider,
            reason: `Found a credential from ${found.source}, but it failed: ${result.detail}`,
          };
        }
        await this.#saveCredential(() => {
          if (found.kind === "chatgpt") this.config.agent.codexAuthJson = found.value;
          else this.config.agent.codexApiKey = found.value;
        });
        return {
          status: "connected",
          provider,
          detail: `${result.detail} (from ${found.source})`,
          config: redactConfig(this.config),
        };
      }
      case "grok": {
        const found = await discoverXaiCredential();
        if (!found) {
          return {
            status: "manual",
            provider,
            reason:
              "No Grok credential found on this machine (checked XAI_API_KEY, GROK_CODE_XAI_API_KEY, GROK_AUTH, and ~/.grok/auth.json). Log in with `grok login` and connect again, or paste an xAI API key.",
          };
        }
        const result =
          found.kind === "grok" ? validateGrokAuth(found.value) : await validateXaiApiKey(found.value);
        if (!result.ok) {
          return {
            status: "manual",
            provider,
            reason: `Found a credential from ${found.source}, but it failed: ${result.detail}`,
          };
        }
        await this.#saveCredential(() => {
          if (found.kind === "grok") {
            this.config.agent.grokAuthJson = found.value;
            this.config.agent.xaiApiKey = "";
          } else {
            this.config.agent.xaiApiKey = found.value;
            this.config.agent.grokAuthJson = "";
          }
        });
        return {
          status: "connected",
          provider,
          detail: `${result.detail} (from ${found.source})`,
          config: redactConfig(this.config),
        };
      }
    }
  }

  /** Poll the in-flight GitHub device authorization. */
  async pollGithubDevice(): Promise<DevicePollResponse> {
    const session = this.#githubDevice;
    if (!session) return { status: "error", detail: "No device authorization in progress." };
    const outcome = await pollGithubDeviceFlow(session);
    if (outcome.state === "pending") return { status: "pending" };
    this.#githubDevice = undefined;
    if (outcome.state === "error") return { status: "error", detail: outcome.detail };
    const result = await validateGithubToken(outcome.token);
    if (!result.ok) return { status: "error", detail: result.detail };
    await this.#saveCredential(() => {
      this.config.github.token = outcome.token;
    });
    return { status: "connected", detail: result.detail, config: redactConfig(this.config) };
  }

  /** Finish the Linear OAuth redirect: exchange the code and save the token. */
  async completeLinearOauth(state: string, code: string): Promise<CredentialResult> {
    const session = this.#linearOauth;
    if (!session || session.state !== state || Date.now() > session.expiresAt) {
      return { ok: false, detail: "Invalid or expired authorization. Start over." };
    }
    this.#linearOauth = undefined;
    try {
      const tokens = await exchangeLinearCode(session, code);
      const result = await validateLinearApiKey(tokens.accessToken);
      if (!result.ok) return result;
      await this.#saveCredential(() => {
        this.#applyLinearTokens(tokens, { rotation: false });
      }, true);
      return result;
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Repos visible to the connected GitHub token, for the dashboard's picker. */
  async listGithubRepos(): Promise<GithubRepo[]> {
    if (!this.config.github.token) {
      throw new OrchestratorError("invalid", "GitHub is not connected");
    }
    return listRepos(this.config.github.token);
  }

  /** Linear projects, for the dashboard's project-to-repo mapping picker. */
  async listLinearProjects(): Promise<LinearProject[]> {
    if (!this.#linear) {
      throw new OrchestratorError("invalid", "Linear is not connected");
    }
    return this.#linear.listProjects();
  }

  /**
   * The one write path for config.json: merge a deep-partial patch from a
   * settings form, validate the whole config, persist it, and apply it to the
   * live orchestrator. Validation runs against the merged result rather than
   * the patch, so no field is ever judged in isolation and the file on disk
   * is never left invalid.
   */
  async updateSettings(patch: ConfigPatch): Promise<SettingsUpdateResponse> {
    // The dashboard only ever sees the mask, so a form that round-tripped one
    // would silently overwrite a live secret with three asterisks.
    if (readConfigPath(patch, "connect.linearClientSecret") === MASKED_SECRET) {
      throw new OrchestratorError("invalid", "connect.linearClientSecret: replace it or leave it alone");
    }

    return this.#transact(async () => {
      const before = structuredClone(this.config);
      const merged = mergeConfigPatch(before as unknown as Record<string, unknown>, patch);
      const result = configSchema.safeParse(merged);
      if (!result.success) {
        const issue = result.error.issues[0];
        const path = issue?.path.join(".");
        throw new OrchestratorError(
          "invalid",
          path ? `${path}: ${issue?.message}` : (issue?.message ?? "invalid settings"),
        );
      }
      const next = result.data;
      // Compared on the parsed result, not on the patch: naming no secret
      // path is not the same as changing no secret. Deleting a whole section
      // ({"linear": null}) lets the schema's defaults refill it with empty
      // strings, which would disconnect the provider through a form.
      const secrets = changedSecretPaths(before, next);
      if (secrets.length > 0) {
        throw new OrchestratorError(
          "invalid",
          `${secrets.join(", ")} cannot be changed here; connect the provider instead`,
        );
      }
      const saved = await this.#writeAndApply(next, patch);
      this.#reactToSettings(before, saved);
      return {
        config: redactConfig(this.config),
        applied: needsRestart(before, saved) ? "restart" : "live",
      };
    });
  }

  /**
   * Serialize whole config transactions: snapshot, merge, validate, write,
   * apply. Chaining only the write is not enough, because two overlapping
   * transactions would each snapshot the config before the other applied and
   * the second would write the first's change straight back out.
   */
  #transact<T>(work: () => Promise<T>): Promise<T> {
    // Both handlers, so one transaction failing doesn't strand the queue.
    const run = this.#configTx.then(work, work);
    this.#configTx = run.catch(() => undefined);
    return run;
  }

  /**
   * Write a candidate config and install it, as one step of the write chain.
   * Doing both here (rather than applying first and rolling back on failure)
   * means the live config never holds values that didn't reach disk, and
   * leaves no rollback that could revert a change made in the meantime.
   */
  async #writeAndApply(candidate: BreviConfig, patch: ConfigPatch): Promise<BreviConfig> {
    const write = this.#configWrite.then(async () => {
      // Credentials are owned by the connect flows, which mutate the live
      // config directly and can land while this transaction is in flight.
      // Settings patches provably never touch them (see changedSecretPaths),
      // so the live values are always the ones to persist.
      const merged = structuredClone(candidate);
      for (const path of SETTINGS_SECRET_PATHS) {
        writeConfigPath(merged, path, readConfigPath(this.config, path));
      }
      const written = await saveConfig(merged, this.#configPath);
      // The write awaited above, and a connect flow (a token refresh, an R2
      // provision) may have moved the live config meanwhile. Installing the
      // candidate wholesale would revert it, and that flow's own queued
      // persist would then write the reverted state out. Re-applying just this
      // transaction's patch onto the config as it now stands keeps both.
      const applied = configSchema.parse(
        mergeConfigPatch(structuredClone(this.config) as unknown as Record<string, unknown>, patch),
      );
      if (serializeConfig(applied) !== serializeConfig(written)) {
        // Reconcile the file in this same step rather than relying on the
        // other flow's persist to arrive: until the two agree, the config
        // watcher would read the file back as a hand edit and undo the
        // change that landed here.
        await saveConfig(applied, this.#configPath);
      }
      this.#lastWritten = serializeConfig(applied);
      assignInPlace(this.config, applied);
      return applied;
    });
    // Keep the chain alive after a failed write; only the caller sees the error.
    this.#configWrite = write.catch(() => undefined);
    return write;
  }

  /** Pick up whatever the new config changed: timers, queue, and the dashboard. */
  #reactToSettings(before: BreviConfig, next: BreviConfig): void {
    const changed = (path: string): boolean =>
      JSON.stringify(readConfigPath(before, path)) !== JSON.stringify(readConfigPath(next, path));

    if (changed("pollIntervalSeconds")) this.#armPollTimer();
    if (changed("linear.teamKeys")) this.#tickets = [];
    this.emit("config", redactConfig(this.config));
    if (changed("repos")) {
      this.#warnedNoRepo.clear();
      void this.poll(); // Tickets may now resolve to a repo.
    } else if (changed("trigger.label") || changed("linear.teamKeys")) {
      void this.poll(); // A different set of tickets is eligible now.
    }
  }

  /** (Re)arm the Linear poll loop on the configured interval. */
  #armPollTimer(): void {
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    if (this.#stopped) return;
    this.#pollTimer = setInterval(() => void this.poll(), this.config.pollIntervalSeconds * 1000);
    this.#pollTimer.unref();
  }

  /**
   * Watch config.json for hand edits so the file stays the source of truth:
   * an external change is picked up without a restart and broadcast like any
   * other config change. The directory is watched rather than the file
   * because saveConfig renames a temp file into place, which a file-level
   * watch would not survive.
   */
  #watchConfigFile(): void {
    const file = basename(this.#configPath);
    try {
      this.#configWatcher = watch(dirname(this.#configPath), (_event, name) => {
        if (name !== null && basename(name.toString()) !== file) return;
        if (this.#configReloadTimer) clearTimeout(this.#configReloadTimer);
        // Editors save in bursts (truncate, write, chmod); let it settle.
        this.#configReloadTimer = setTimeout(
          () => void this.#reloadConfigFile(),
          CONFIG_RELOAD_DEBOUNCE_MS,
        );
        this.#configReloadTimer.unref();
      });
      this.#configWatcher.unref();
    } catch {
      // Watching is a convenience and not every filesystem supports it; the
      // dashboard's own writes still work, they just won't see hand edits.
    }
  }

  /** Live state of the Cloudflare R2 evidence connector, probed via wrangler on every call. */
  async r2Status(): Promise<R2Status> {
    const wrangler = await checkWrangler();
    const { bucket, publicBaseUrl } = this.config.r2;
    return {
      ...wrangler,
      bucket,
      publicBaseUrl,
      ready: wrangler.installed && wrangler.loggedIn && bucket !== "" && publicBaseUrl !== "",
    };
  }

  /**
   * One-click R2 connect: start `wrangler login` on the host if not yet
   * authenticated, or, once logged in, provision the evidence bucket
   * automatically (create or reuse it, enable its r2.dev public URL) and
   * persist the result. A bucket and URL already configured is a no-op that
   * just reports connected.
   */
  async connectR2(): Promise<R2ConnectResponse> {
    const wrangler = await checkWrangler();
    if (!wrangler.installed) {
      return {
        status: "unavailable",
        reason:
          "The wrangler CLI is not installed on this machine. Install it with npm install -g wrangler, then connect again.",
      };
    }
    if (wrangler.loggedIn) {
      if (this.config.r2.bucket !== "" && this.config.r2.publicBaseUrl !== "") {
        return { status: "connected", r2: await this.r2Status() };
      }
      const provisioned = await provisionBucket(this.config.r2.bucket || DEFAULT_EVIDENCE_BUCKET);
      if (!provisioned.ok) {
        return { status: "provision-failed", reason: provisioned.reason, r2: await this.r2Status() };
      }
      this.config.r2.bucket = provisioned.bucket;
      this.config.r2.publicBaseUrl = provisioned.publicBaseUrl;
      await this.#persistConfig();
      this.emit("config", redactConfig(this.config));
      return { status: "connected", r2: await this.r2Status() };
    }
    if (!this.#r2Login) {
      this.#r2Login = startWranglerLogin().finally(() => {
        this.#r2Login = undefined;
      });
    }
    return {
      status: "login-started",
      detail: "Finish logging in to Cloudflare in the opened browser tab; this panel updates by itself.",
    };
  }

  /** Cancel a queued, waiting, or active run. Terminal runs are returned unchanged. */
  cancelRun(runId: string): Promise<Run> {
    return this.#withRunLock(runId, async () => {
      const run = this.store.get(runId);
      if (!run) throw new OrchestratorError("not-found", `no run with id ${runId}`);
      if (isTerminal(run.status)) return run;
      if (run.status === "waiting") {
        this.#clearResume(runId);
        return this.store.setStatus(runId, "cancelled", {
          finishedAt: new Date().toISOString(),
          resumeAt: undefined,
        });
      }
      // "queued" covers two different situations now that dispatch is a
      // network round trip rather than an in-process handoff: still sitting
      // in #queue (never sent anywhere), or already handed to a worker and
      // simply not yet reported "preparing" back. Only the former can be
      // cancelled locally; the latter has to go through the worker like any
      // other active run, below.
      if (run.status === "queued" && this.#queue.includes(runId)) {
        this.#queue = this.#queue.filter((id) => id !== runId);
        // A cancelled queued follow-up must not misroute a later retry into
        // the follow-up path. It also still owns its retained disk's reap
        // timer (starting the follow-up cleared it, and nothing will reach
        // #onRunSettled to re-arm it), so restore the reaper here.
        if (this.#followUps.delete(runId)) this.#scheduleReap(runId);
        return this.store.setStatus(runId, "cancelled", { finishedAt: new Date().toISOString() });
      }
      const outcome: CancelOutcome = this.#workers?.cancel(runId) ?? "unknown";
      if (outcome === "sent") return this.store.get(runId) ?? run;
      if (outcome === "pending") {
        // The owning worker is mid-reconnect; the registry holds onto the
        // cancel and replays it once the worker's socket comes back, so
        // there is nothing more to do here than say so.
        this.store.appendEvent({
          runId,
          ts: new Date().toISOString(),
          type: "log",
          stream: "system",
          text: "cancellation recorded; it will be delivered once the run's worker reconnects",
        });
        return this.store.get(runId) ?? run;
      }
      // "unknown": no lease exists for this run at all, so no worker is out
      // there executing it (every earlier branch above already handled the
      // still-queued and waiting cases). Nothing to tell a worker; cancel it
      // here instead of leaving it stuck "active" forever.
      return this.store.setStatus(runId, "cancelled", { finishedAt: new Date().toISOString() });
    });
  }

  /**
   * Manually start a new attempt of a failed, cancelled, or waiting run. For
   * a waiting run this skips the rest of the wait and re-queues immediately.
   */
  retryRun(runId: string): Promise<Run> {
    return this.#withRunLock(runId, async () => {
      const run = this.store.get(runId);
      if (!run) throw new OrchestratorError("not-found", `no run with id ${runId}`);
      if (ACTIVE_STATUSES.has(run.status)) {
        throw new OrchestratorError("conflict", `run ${runId} is already ${run.status}`);
      }
      if (run.status === "completed") {
        throw new OrchestratorError(
          "conflict",
          `run ${runId} completed; update the ticket to trigger a fresh run instead`,
        );
      }
      const clash = this.store
        .runsForTicket(run.ticket.id)
        .find((other) => other.id !== runId && !isTerminal(other.status));
      if (clash) {
        throw new OrchestratorError(
          "conflict",
          `ticket ${run.ticket.identifier} already has an active run (${clash.id})`,
        );
      }
      return this.#requeue(runId);
    });
  }

  /**
   * Start a follow-up on a completed run's open PR: rebase onto the latest
   * base, address review feedback, push, and comment. The ticket's Linear
   * state is left untouched. Serialized under the run's mutation lock so it
   * can never interleave with a cancel or retry of the same run.
   */
  followUpRun(runId: string): Promise<Run> {
    if (!isSafePathSegment(runId)) throw new OrchestratorError("invalid", "malformed run id");
    return this.#withRunLock(runId, () => this.#followUpRunLocked(runId));
  }

  async #followUpRunLocked(runId: string): Promise<Run> {
    const run = this.store.get(runId);
    if (!run) throw new OrchestratorError("not-found", `no run with id ${runId}`);
    if (this.#followUps.has(runId)) {
      throw new OrchestratorError("conflict", `a follow-up is already starting for run ${runId}`);
    }
    if (ACTIVE_STATUSES.has(run.status) || run.status === "waiting") {
      throw new OrchestratorError("conflict", `run ${runId} is already ${run.status}`);
    }
    // Completed runs qualify, and so do failed or cancelled follow-ups: they
    // keep their PR result (a retry clears it), so the feedback workflow can
    // be tried again instead of forcing a retry that redoes the whole ticket.
    const prUrl = run.result?.prUrl;
    if (!prUrl) {
      throw new OrchestratorError(
        "invalid",
        run.status === "completed"
          ? "the run has no pull request to follow up on"
          : "only runs that delivered a pull request can take another look; use retry to start the ticket over",
      );
    }
    if (!this.config.github.token) {
      throw new OrchestratorError(
        "invalid",
        "GitHub is not connected: add a token in the dashboard's Connections panel before running a follow-up",
      );
    }
    const clash = this.store
      .runsForTicket(run.ticket.id)
      .find((other) => other.id !== runId && !isTerminal(other.status));
    if (clash) {
      throw new OrchestratorError(
        "conflict",
        `ticket ${run.ticket.identifier} already has an active run (${clash.id})`,
      );
    }
    if (this.#workers?.hasAttachSession(runId)) {
      throw new OrchestratorError(
        "conflict",
        "an interactive session is attached to this run's sandbox; detach it before starting a follow-up",
      );
    }

    // Reserve the run before the first await: two concurrent requests could
    // otherwise both pass the checks above during the GitHub round-trip and
    // queue the same run twice. The reservation doubles as the execution-kind
    // marker #buildDispatchPayload claims; it is released only on failure
    // here, when a queued follow-up is cancelled, or by a successful dispatch.
    this.#followUps.add(runId);
    try {
      try {
        const pr = await fetchPrStatus(prUrl, this.config.github.token);
        // A draft is still an open PR: it can receive feedback and pushes.
        if (pr.state !== "open" && pr.state !== "draft") {
          throw new OrchestratorError("conflict", `the pull request is ${pr.state}`);
        }
      } catch (error) {
        if (error instanceof OrchestratorError) throw error;
        throw new OrchestratorError(
          "invalid",
          `could not check the pull request: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // The GitHub check took real time; the run must still be eligible, and
      // an interactive resume may have attached to the retained sandbox
      // during the await (resumeRun also rejects while the reservation above
      // is held, so this recheck is belt and braces).
      const current = this.store.get(runId);
      if (!current || !isTerminal(current.status) || !current.result?.prUrl) {
        throw new OrchestratorError("conflict", `run ${runId} is no longer eligible for a follow-up`);
      }
      if (this.#workers?.hasAttachSession(runId)) {
        throw new OrchestratorError(
          "conflict",
          "an interactive session is attached to this run's sandbox; detach it before starting a follow-up",
        );
      }

      // Take ownership of the retained disk for the duration: clear any
      // pending reap timer without discarding it. #onRunSettled re-arms the
      // reaper after the run (see its existing tail below), and cancelling
      // the queued follow-up re-arms it too.
      const reapTimer = this.#reapTimers.get(runId);
      if (reapTimer) clearTimeout(reapTimer);
      this.#reapTimers.delete(runId);

      // result is deliberately kept: the dashboard uses an active run that
      // still carries its PR result to render the follow-up spinner, and the
      // PR context must survive.
      const queued = await this.store.setStatus(runId, "queued", {
        queuedAt: new Date().toISOString(),
        finishedAt: undefined,
        error: undefined,
        limit: undefined,
        resumeAt: undefined,
      });
      if (!this.#queue.includes(runId)) this.#queue.push(runId);
      this.#dispatchQueued();
      return queued;
    } catch (error) {
      this.#followUps.delete(runId);
      // Re-arm the reaper in case the timer was already cleared above; a
      // no-op when the run holds no retained disk.
      this.#scheduleReap(runId);
      throw error;
    }
  }

  /** Live open/merged/closed state of a run's PR, for the dashboard's follow-up button. */
  async prStatus(runId: string): Promise<PrStatusResponse> {
    if (!isSafePathSegment(runId)) throw new OrchestratorError("invalid", "malformed run id");
    const run = this.store.get(runId);
    if (!run) throw new OrchestratorError("not-found", `no run with id ${runId}`);
    const prUrl = run.result?.prUrl;
    if (!prUrl) throw new OrchestratorError("invalid", "the run has no pull request");
    if (!this.config.github.token) throw new OrchestratorError("invalid", "GitHub is not connected");
    try {
      return await fetchPrStatus(prUrl, this.config.github.token);
    } catch (error) {
      throw new OrchestratorError(
        "invalid",
        `could not check the pull request: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Check a finished run is eligible for interactive resume and resolve
   * which worker its retained sandbox lives on. `brevi attach` and the
   * dashboard's web terminal both call this first, then open
   * `WS /ws/runs/:id/attach`, which the host relays to that worker: the
   * sandbox itself never lives on the scheduling host, so there is nothing
   * left for this call to boot.
   */
  async resumeRun(runId: string): Promise<ResumeRunResponse> {
    if (!isSafePathSegment(runId)) throw new OrchestratorError("invalid", "malformed run id");
    const run = this.store.get(runId);
    if (!run) throw new OrchestratorError("not-found", `no run with id ${runId}`);
    if (run.status !== "completed" && run.status !== "failed") {
      throw new OrchestratorError("conflict", `run ${runId} is ${run.status}; only finished runs can be resumed`);
    }
    // A follow-up reservation covers the window between its synchronous
    // checks and the run leaving "completed": attaching then would hand the
    // interactive session a disk the queued follow-up is about to rehydrate.
    if (this.#followUps.has(runId)) {
      throw new OrchestratorError(
        "conflict",
        `a follow-up is starting for run ${runId}; wait for it to finish before attaching`,
      );
    }
    const retainedUntil = run.sandbox.retainedUntil;
    if (!retainedUntil || Date.parse(retainedUntil) <= Date.now()) {
      throw new OrchestratorError(
        "gone",
        "the run's sandbox is no longer available; it was cleaned up when the retention window ended",
      );
    }
    if (!run.agentSessionId) {
      throw new OrchestratorError(
        "invalid",
        "no agent session id was captured for this run; interactive resume supports Claude runs only",
      );
    }
    const worker = this.#workers?.workerFor(runId);
    if (!worker) {
      throw new OrchestratorError(
        "conflict",
        "the worker holding this run's sandbox isn't connected right now; it can't be resumed",
      );
    }
    return { run, attach: { kind: "worker", workerId: worker.id, workerName: worker.name } };
  }

  /**
   * Thin on purpose: the worker that holds a run's retained sandbox releases
   * its compute itself once the last attach session for that run closes (see
   * WorkerRegistry.openAttach), so the host has nothing left to release. The
   * endpoint stays so `brevi attach` and the dashboard's terminal keep a
   * symmetric resume/release pair to call, without needing to know that the
   * second half became a no-op when execution moved to the fleet.
   */
  async releaseRun(runId: string): Promise<Run> {
    const run = this.store.get(runId);
    if (!run) throw new OrchestratorError("not-found", `no run with id ${runId}`);
    return run;
  }

  /** Stop polling and abort any active run. Resolves once the worker settles. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    if (this.#prTimer) clearInterval(this.#prTimer);
    if (this.#configReloadTimer) clearTimeout(this.#configReloadTimer);
    this.#configWatcher?.close();
    // Waiting runs stay "waiting" on disk; the next boot reschedules them.
    for (const timer of this.#resumeTimers.values()) clearTimeout(timer);
    this.#resumeTimers.clear();
    // Queued runs are left in #queue and on disk exactly as "queued": the
    // next boot's #recoverRuns reloads them, so there is nothing to unwind
    // here. Cancelling them on the way out is exactly the loss this ticket
    // removes: a host restart no longer forfeits work that hadn't even
    // started yet.
    for (const timer of this.#reapTimers.values()) clearTimeout(timer);
    this.#reapTimers.clear();
    // Runs already handed to a worker keep running there: the registry only
    // closes its sockets and flushes the leases to disk, so the next boot's
    // restore() re-adopts them and a reconnecting worker resumes reporting.
    // Their compute and any retained disk live on the worker, not here, so
    // there's nothing local left to clean up for them.
    await this.#workers?.stop();
    await this.store.flush();
  }

  #activeOrQueuedRun(ticketId: string): Run | undefined {
    // "waiting" counts: a run parked on a limit reset still owns its ticket.
    return this.store.runsForTicket(ticketId).find((run) => !isTerminal(run.status));
  }

  /** apiKey looks like an OAuth access token rather than a plain `lin_api_` personal key, which never expires. */
  #isLinearOauthToken(): boolean {
    const key = this.config.linear.apiKey;
    return key !== "" && !key.startsWith("lin_api_");
  }

  /**
   * Apply a fresh Linear token grant to config. On a rotation (a refresh) a
   * response that omits refresh_token means Linear didn't issue a new one,
   * so the existing one is kept; a fresh exchange always overwrites, since a
   * leftover value from a previous connection would otherwise stick around.
   */
  #applyLinearTokens(tokens: LinearTokens, { rotation }: { rotation: boolean }): void {
    this.config.linear.apiKey = tokens.accessToken;
    this.config.linear.refreshToken = rotation
      ? (tokens.refreshToken ?? this.config.linear.refreshToken)
      : (tokens.refreshToken ?? "");
    this.config.linear.tokenExpiresAt = tokens.expiresIn
      ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString()
      : "";
  }

  /**
   * Rebuild (or drop) the Linear client after a user-initiated credential
   * change and invalidate everything tied to the previous credential: the
   * generation bump makes any in-flight refresh discard its response, and
   * the error and backoff states no longer apply either way.
   */
  #resetLinearConnection(): void {
    this.#linearGeneration += 1;
    this.#linearRefreshBackoff = undefined;
    this.#linearAuthError = undefined;
    this.#linearRefreshFailing = undefined;
    this.#linear = this.config.linear.apiKey
      ? new LinearService(this.config, this.#linearAuth)
      : undefined;
  }

  /**
   * Persist config through one chain so writes never interleave. config is
   * shared by reference and serialized at write time, so the last chained
   * write always matches the final in-memory state; without the chain a
   * slow write from an older mutation (a token refresh) could land after a
   * newer one (a disconnect) and revive credentials the user removed.
   */
  #persistConfig(): Promise<void> {
    const write = this.#configWrite.then(async () => {
      const saved = await saveConfig(this.config, this.#configPath);
      // Remember what landed on disk so the config watcher can tell brevi's
      // own writes apart from a hand edit without any extra bookkeeping.
      this.#lastWritten = serializeConfig(saved);
      return saved;
    });
    // Keep the chain alive after a failed write; only the caller sees the error.
    this.#configWrite = write.catch(() => undefined);
    return write.then(() => undefined);
  }

  /** The config file changed under us; adopt it, or say why it was ignored. */
  async #reloadConfigFile(): Promise<void> {
    await this.#transact(async () => {
      if (this.#stopped) return;
      let raw: string;
      try {
        raw = await readFile(this.#configPath, "utf8");
      } catch {
        return; // Mid-rename or deleted; the next event settles it.
      }
      // stop() can land while the read is in flight; applying after shutdown
      // would emit to closed clients and re-arm the poll timer.
      if (this.#stopped) return;
      // Our own writes come back through the watcher too. Comparing the
      // serialized form skips them with no bookkeeping to fall out of sync.
      if (raw === this.#lastWritten) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return; // A half-written file from a non-atomic editor; wait for the rest.
      }
      const result = configSchema.safeParse(parsed);
      if (!result.success) {
        console.error(
          `[brevi] ${this.#configPath} was edited into an invalid state (${result.error.issues[0]?.message ?? "invalid"}); keeping the settings already loaded.`,
        );
        return;
      }
      const before = structuredClone(this.config);
      const next = result.data;
      if (serializeConfig(before) === serializeConfig(next)) return;
      console.log(`[brevi] Reloaded ${this.#configPath} after an external edit.`);
      // Secrets live in this same file, so a hand edit legitimately carries
      // them; they are applied like any other field.
      assignInPlace(this.config, next);
      if (
        before.linear.apiKey !== next.linear.apiKey ||
        before.linear.refreshToken !== next.linear.refreshToken
      ) {
        this.#resetLinearConnection();
        // A key that was edited away leaves tickets nobody can act on; the
        // next poll returns early, so they would sit there until a restart.
        if (!this.config.linear.apiKey) {
          this.#tickets = [];
          this.emit("tickets", this.#tickets);
        }
        this.emit("linear-status", this.linearStatus);
      }
      this.#reactToSettings(before, next);
    });
  }

  /** Pause polling on a dead Linear credential and tell the dashboard. Idempotent: repeat calls while already in the state say nothing. */
  #enterLinearAuthError(detail: string): void {
    if (this.#linearAuthError !== undefined) return;
    this.#linearAuthError = detail;
    this.#linearRefreshFailing = undefined;
    console.error(
      `[brevi] Linear authentication failed: ${detail}. Reconnect Linear from the dashboard's Connectors page; polling is paused until then.`,
    );
    this.emit("linear-status", this.linearStatus);
  }

  /**
   * The expired token can't be refreshed right now for a retryable reason
   * (network, 5xx, rate limit): pause polling, say so once, and keep
   * retrying on the refresh backoff. Idempotent like the auth-error
   * transition, and a no-op once the credential is confirmed dead.
   */
  #enterLinearRefreshFailing(detail: string): void {
    if (this.#linearAuthError !== undefined || this.#linearRefreshFailing !== undefined) return;
    this.#linearRefreshFailing = detail;
    console.error(
      `[brevi] Linear token refresh failed: ${detail}. Retrying automatically; polling is paused until a refresh succeeds.`,
    );
    this.emit("linear-status", this.linearStatus);
  }

  /** A refresh succeeded: leave the paused state and let polling pick back up. */
  #clearLinearRefreshFailing(): void {
    if (this.#linearRefreshFailing === undefined) return;
    this.#linearRefreshFailing = undefined;
    console.log("[brevi] Linear token refresh succeeded; polling resumed.");
    this.emit("linear-status", this.linearStatus);
  }

  /**
   * Reactive recovery, called by LinearService when any call fails
   * authentication: try a refresh and report whether retrying the call is
   * worthwhile. All connector state transitions happen here, so poll() and
   * one-off calls (the dashboard's project list, a run posting its comment)
   * behave identically.
   */
  async #recoverLinearAuth(): Promise<boolean> {
    if (this.#linearAuthError !== undefined) return false;
    const outcome = await this.#refreshLinear();
    if (outcome.ok) return true;
    if (outcome.reason === "stale") return false;
    if (outcome.reason === "permanent") {
      this.#enterLinearAuthError(outcome.detail);
      return false;
    }
    this.#enterLinearRefreshFailing(outcome.detail);
    return false;
  }

  /**
   * Refresh the stored Linear OAuth token. Concurrent callers (a proactive
   * refresh from the poll's expiry check and reactive ones from failed
   * calls) share one in-flight attempt, and a transient failure arms a
   * backoff (honoring Retry-After) during which further attempts fail fast
   * without hitting the network. The response is applied and persisted only
   * while the credential is still the one the refresh started from; a
   * connect, disconnect, or manual key mid-flight makes it stale and it is
   * discarded. LinearService picks up the new key on its own the next time
   * it's used, since config is shared by reference.
   */
  #refreshLinear(): Promise<LinearRefreshOutcome> {
    if (this.#linearRefresh) return this.#linearRefresh;
    const backoff = this.#linearRefreshBackoff;
    if (backoff && Date.now() < backoff.until) {
      return Promise.resolve({ ok: false, reason: "transient", detail: backoff.detail });
    }
    this.#linearRefresh = (async (): Promise<LinearRefreshOutcome> => {
      const generation = this.#linearGeneration;
      const refreshToken = this.config.linear.refreshToken;
      if (!refreshToken) {
        return {
          ok: false,
          reason: "permanent",
          detail: "the Linear token was rejected and no refresh token is stored",
        };
      }
      const app = linearOauthApp(this.config);
      const source = app ? { app } : { apiBase: this.config.connect.apiBase };
      try {
        const tokens = await refreshLinearToken(source, refreshToken);
        if (
          generation !== this.#linearGeneration ||
          this.config.linear.refreshToken !== refreshToken
        ) {
          return { ok: false, reason: "stale" };
        }
        this.#applyLinearTokens(tokens, { rotation: true });
        this.#linearRefreshBackoff = undefined;
        this.#clearLinearRefreshFailing();
        await this.#persistConfig();
        this.emit("config", redactConfig(this.config));
        return { ok: true };
      } catch (error) {
        if (generation !== this.#linearGeneration) return { ok: false, reason: "stale" };
        if (error instanceof LinearRefreshError && error.permanent) {
          return { ok: false, reason: "permanent", detail: error.message };
        }
        const detail = error instanceof Error ? error.message : String(error);
        const attempts = (this.#linearRefreshBackoff?.attempts ?? 0) + 1;
        const wait = Math.max(
          Math.min(LINEAR_REFRESH_BACKOFF_BASE_MS * 2 ** (attempts - 1), LINEAR_REFRESH_BACKOFF_MAX_MS),
          (error instanceof LinearRefreshError ? error.retryAfterMs : undefined) ?? 0,
        );
        this.#linearRefreshBackoff = { attempts, until: Date.now() + wait, detail };
        return { ok: false, reason: "transient", detail };
      }
    })().finally(() => {
      this.#linearRefresh = undefined;
    });
    return this.#linearRefresh;
  }

  /** Run one state-changing command under the run's mutation lock. */
  #withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const tail = this.#runLocks.get(runId) ?? Promise.resolve();
    const next = tail.then(fn, fn);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.#runLocks.set(runId, settled);
    void settled.then(() => {
      if (this.#runLocks.get(runId) === settled) this.#runLocks.delete(runId);
    });
    return next;
  }

  /**
   * Put a run back in the queue for its next attempt. `queueReason` is set
   * when the caller already knows why the run isn't executing (an
   * interruption); otherwise it is cleared like every other per-attempt
   * field, since #dispatchQueued sets its own reason the next time
   * placement is tried.
   */
  async #requeue(runId: string, queueReason?: string): Promise<Run> {
    this.#clearResume(runId);
    // A retry starts from a fresh checkout, so any sandbox retained from the
    // previous attempt is stale before it's ever used again; discard it now
    // rather than let it linger until its own retention window ends.
    await this.#discardRetained(runId);
    return this.#enqueueForAttempt(runId, queueReason);
  }

  /**
   * Shared tail of #requeue: flip the run back to "queued" and let
   * #dispatchQueued try it against the fleet. Split out so
   * #onRunInterrupted can reach it without #requeue's own discard step,
   * whose failure it has to survive (see there for why).
   */
  async #enqueueForAttempt(runId: string, queueReason?: string): Promise<Run> {
    // Shed the previous attempt's outcome right away rather than at the
    // "preparing" transition: the queued snapshot goes straight to clients,
    // and a stale result/error would keep the dashboard's Result tab alive
    // for as long as the run waits for a free worker. Run-level PR metadata
    // (prUrl, prState) survives: the PR still exists while the retry runs,
    // and finalization replaces it.
    const run = await this.store.setStatus(runId, "queued", {
      resumeAt: undefined,
      queuedAt: new Date().toISOString(),
      finishedAt: undefined,
      error: undefined,
      limit: undefined,
      result: undefined,
      queueReason,
    });
    if (!this.#queue.includes(runId)) this.#queue.push(runId);
    this.#dispatchQueued();
    return run;
  }

  #clearResume(runId: string): void {
    const timer = this.#resumeTimers.get(runId);
    if (timer) clearTimeout(timer);
    this.#resumeTimers.delete(runId);
  }

  /**
   * Tear down a run's retained sandbox by asking the worker holding it to
   * discard the disk. Shared by the reaper (retention window expired) and
   * requeue (a retry makes any retained disk stale immediately). The wire
   * protocol has no discard acknowledgement, so "reached the worker" is as
   * much confirmation as the host ever gets; when the worker isn't connected
   * at all, the disk genuinely can't be reclaimed from here, so this throws
   * and retainedUntil is left in place rather than reporting the sandbox as
   * gone (it carries credential material). The reaper's own retry (see
   * #maybeReap) is what tries again later; #requeue propagates the failure
   * as-is.
   */
  async #discardRetained(runId: string): Promise<void> {
    const timer = this.#reapTimers.get(runId);
    if (timer) clearTimeout(timer);
    this.#reapTimers.delete(runId);

    const run = this.store.get(runId);
    if (run?.sandbox.retainedUntil) {
      if (!this.#workers?.discard(runId)) {
        throw new Error(`the worker holding run ${runId}'s retained sandbox isn't connected`);
      }
    }

    const current = this.store.get(runId);
    if (current?.sandbox.retainedUntil) {
      await this.store.update(runId, { sandbox: { ...current.sandbox, retainedUntil: undefined } });
    }
  }

  /** Arm a timer that reclaims a retained sandbox's disk at retainedUntil (or right away when past). */
  #scheduleReap(runId: string): void {
    const existing = this.#reapTimers.get(runId);
    if (existing) clearTimeout(existing);
    this.#reapTimers.delete(runId);
    const retainedUntil = this.store.get(runId)?.sandbox.retainedUntil;
    if (!retainedUntil) return;
    const dueIn = Math.max(Date.parse(retainedUntil) - Date.now(), 0);
    // setTimeout's delay is a signed 32-bit int; clamp to its max and let
    // #maybeReap re-check and reschedule when the real due time is further out.
    const delay = Math.min(dueIn, 2 ** 31 - 1);
    const timer = setTimeout(() => {
      this.#reapTimers.delete(runId);
      void this.#maybeReap(runId);
    }, delay);
    timer.unref();
    this.#reapTimers.set(runId, timer);
  }

  /**
   * A reap timer fired. Reclaim the disk if the window has actually passed,
   * otherwise reschedule for the remaining time (only reachable after the
   * 32-bit setTimeout clamp above).
   */
  async #maybeReap(runId: string): Promise<void> {
    const retainedUntil = this.store.get(runId)?.sandbox.retainedUntil;
    if (!retainedUntil) return;
    if (Date.parse(retainedUntil) > Date.now()) {
      this.#scheduleReap(runId);
      return;
    }
    try {
      await this.#reap(runId);
    } catch (error) {
      console.error(
        `[brevi] failed to reap retained sandbox for ${runId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      // retainedUntil survived the failure (see #discardRetained), but its
      // timer was consumed; re-arm one or the credential-bearing disk would
      // sit unreclaimed until the next restart's sweep.
      const retry = setTimeout(() => {
        this.#reapTimers.delete(runId);
        void this.#maybeReap(runId);
      }, REAP_RETRY_MS);
      retry.unref();
      this.#reapTimers.set(runId, retry);
    }
  }

  /** Reclaim a run's retained sandbox disk once its retention window has passed. */
  async #reap(runId: string): Promise<void> {
    await this.#discardRetained(runId);
    const run = this.store.get(runId);
    if (!run) return; // run was removed while the reap was in flight
    this.store.appendEvent({
      runId,
      ts: new Date().toISOString(),
      type: "log",
      stream: "system",
      text: "retained sandbox expired and was removed",
    });
  }

  /** Arm a timer that fires at the run's resumeAt (or right away when past). */
  #scheduleResume(runId: string): void {
    if (this.#stopped) return;
    this.#clearResume(runId);
    const run = this.store.get(runId);
    if (run?.status !== "waiting") return;
    const dueAt = run.resumeAt ? Date.parse(run.resumeAt) : Number.NaN;
    const dueIn = Math.max(Number.isFinite(dueAt) ? dueAt - Date.now() : 0, 5_000);
    const timer = setTimeout(() => {
      this.#resumeTimers.delete(runId);
      void this.#tryResume(runId);
    }, dueIn);
    timer.unref();
    this.#resumeTimers.set(runId, timer);
  }

  /**
   * The resume timer fired: confirm the limit has lifted with a 1-token probe,
   * then re-queue the run, or push resumeAt out one probe interval when the
   * provider is still limited.
   */
  async #tryResume(runId: string): Promise<void> {
    if (this.#stopped) return;
    const run = this.store.get(runId);
    // Cancelled or manually retried while the timer was pending.
    if (run?.status !== "waiting") return;
    const log = (text: string): void => {
      this.store.appendEvent({ runId, ts: new Date().toISOString(), type: "log", stream: "system", text });
    };
    try {
      const provider = run.limit?.provider ?? agentProvider(this.config);
      const probe = await probeAgentLimit(this.config, provider);
      // The probe took real time; the run may have been cancelled or manually
      // resumed meanwhile, and requeueing would overwrite that decision.
      if (this.store.get(runId)?.status !== "waiting") return;
      if (!probe.ready) {
        const resumeAt = new Date(
          Date.now() + this.config.restart.probeIntervalMinutes * 60_000,
        ).toISOString();
        await this.store.update(runId, { resumeAt });
        log(`still limited (${probe.detail}); probing again at ${resumeAt}`);
        this.#scheduleResume(runId);
        return;
      }
      log(`limit lifted (${probe.detail}); starting next attempt`);
      await this.#withRunLock(runId, async () => {
        // A cancel or manual retry may have raced the probe; only a run
        // still waiting on its limit belongs to this auto-restart.
        if (this.store.get(runId)?.status !== "waiting") return;
        await this.#requeue(runId);
      });
    } catch (error) {
      // A broken probe must not strand the run; try again next interval.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[brevi] resume of ${runId} failed: ${message}`);
      if (this.store.get(runId)?.status !== "waiting") return;
      await this.store
        .update(runId, {
          resumeAt: new Date(Date.now() + this.config.restart.probeIntervalMinutes * 60_000).toISOString(),
        })
        .catch(() => undefined);
      this.#scheduleResume(runId);
    }
  }

  /**
   * Auto-queue a ticket when it has a resolved repo and no run exists for this
   * (ticket.id, ticket.updatedAt) revision. A ticket updated after a terminal
   * run is eligible again; a ticket with an active run never is.
   */
  async #maybeAutoQueue(ticket: Ticket): Promise<void> {
    if (!ticket.repo) {
      if (!this.#warnedNoRepo.has(ticket.id)) {
        this.#warnedNoRepo.add(ticket.id);
        console.warn(
          `[brevi] ${ticket.identifier} is eligible but has no repo mapping; add a "repo:<key>" label or name its project after a repo key. It will not run automatically.`,
        );
      }
      return;
    }
    if (!this.config.github.token) {
      if (!this.#warnedNoRepo.has(`github:${ticket.id}`)) {
        this.#warnedNoRepo.add(`github:${ticket.id}`);
        console.warn(
          `[brevi] ${ticket.identifier} is eligible but GitHub is not connected; add a token in the dashboard's Connections panel.`,
        );
      }
      return;
    }
    const previous = this.store.runsForTicket(ticket.id);
    if (previous.some((run) => !isTerminal(run.status))) return;
    if (previous.some((run) => run.ticket.updatedAt === ticket.updatedAt)) return;
    await this.#enqueue(ticket);
  }

  /** Create the run for a ticket and enter it into the dispatch queue. */
  async #enqueue(ticket: Ticket): Promise<Run> {
    const run = await this.store.createRun(ticket);
    this.#queue.push(run.id);
    this.#dispatchQueued();
    return run;
  }

  /**
   * Drain #queue in FIFO order for as long as the fleet keeps accepting
   * dispatches. A no-op before start() (nothing to dispatch to yet) and
   * after stop(). Every other mutation of #queue (enqueue, requeue, a
   * worker freeing up) funnels through this same method, so there is one
   * place that decides what leaves the queue and when.
   */
  #dispatchQueued(): void {
    if (this.#stopped || !this.#workers) return;
    while (this.#queue.length > 0) {
      const runId = this.#queue[0]!;
      const run = this.store.get(runId);
      // Gone, or claimed by something else (a cancel that raced this drain)
      // since it was queued: drop it and keep going, there is nothing left
      // here for it.
      if (!run || run.status !== "queued") {
        this.#queue.shift();
        continue;
      }
      const payload = this.#buildDispatchPayload(runId);
      if (!payload) {
        // The run has already been failed by the builder (no resolved repo);
        // drop it from the queue and move on to the next one.
        this.#queue.shift();
        continue;
      }
      const outcome: DispatchOutcome = this.#workers.dispatch(payload);
      if (!outcome.placed) {
        // No connected worker has room (or can boot this run's VM size)
        // right now. Leave this run at the head so the next capacity change
        // (a worker connecting, or one of its runs settling) resumes
        // exactly here, and say so once rather than on every fruitless
        // attempt in between.
        if (!this.#warnedNoCapacity) {
          this.#warnedNoCapacity = true;
          console.warn(`[brevi] ${this.#queue.length} run(s) queued but waiting on fleet capacity`);
        }
        // This runs on every heartbeat from every connected worker, so only
        // write when the reason actually changed: an unconditional write
        // here would be a write storm across the whole queue on every tick.
        for (const id of this.#queue) {
          const queuedRun = this.store.get(id);
          if (queuedRun && queuedRun.queueReason !== outcome.reason) {
            void this.store.update(id, { queueReason: outcome.reason }).catch(() => undefined);
          }
        }
        return;
      }
      this.#warnedNoCapacity = false;
      this.#queue.shift();
      if (run.queueReason !== undefined) {
        void this.store.update(runId, { queueReason: undefined }).catch(() => undefined);
      }
      console.log(`[brevi] run ${runId} dispatched to worker ${outcome.workerName} (${outcome.workerId})`);
      // The follow-up marker is only consumed on a successful dispatch: a
      // rejected dispatch (see #onRunRejected) must still know to build a
      // follow-up payload the next time this run is tried.
      if (payload.kind === "follow-up") this.#followUps.delete(runId);
    }
  }

  /**
   * Resolve everything a dispatch needs beyond the run itself. Mirrors how
   * the old in-process executeRun resolved a run's repo: `ticket.repo`
   * already names a configured repo key (Linear resolution picked it before
   * the ticket was ever queued), so this just looks it up
   * in the live config. Returns undefined, after failing the run itself,
   * when that lookup comes up empty: there is no later point in the
   * dispatch path where that failure could be reported instead.
   */
  #buildDispatchPayload(runId: string): DispatchRequest | undefined {
    const run = this.store.get(runId);
    if (!run) return undefined;
    const repoKey = run.ticket.repo;
    const repo = repoKey ? this.config.repos[repoKey] : undefined;
    if (!repoKey || !repo) {
      const text = `ticket ${run.ticket.identifier} has no resolved repo mapping: add a "repo:<key>" label or map its Linear project`;
      this.store.appendEvent({ runId, ts: new Date().toISOString(), type: "log", stream: "system", text });
      void this.store
        .setStatus(runId, "failed", { error: text, finishedAt: new Date().toISOString() })
        .catch(() => undefined);
      return undefined;
    }
    const memories = this.config.memory.enabled
      ? selectMemories(this.memories.list(memoryKeyFor(repo.remote)), this.config.memory.maxChars)
      : [];
    const prompts: DispatchPrompts = {
      prDescription: "concise",
      memories,
      recordMemories: this.config.memory.enabled,
    };
    return {
      kind: this.#followUps.has(runId) ? "follow-up" : "implementation",
      run,
      repoKey,
      repo,
      config: this.config,
      prompts,
    };
  }

  /**
   * A run dispatched to a worker reached a terminal or "waiting" state.
   * Re-arm whatever follow-on timer that implies, the same two #execute's
   * tail used to arm back when a run finished in-process, then try the
   * queue again: this run's slot freeing up on its worker is exactly the
   * kind of capacity change #dispatchQueued was waiting on.
   */
  #onRunSettled(runId: string): void {
    const run = this.store.get(runId);
    if (run?.status === "waiting") this.#scheduleResume(runId);
    if (run?.sandbox.retainedUntil) this.#scheduleReap(runId);
    this.#dispatchQueued();
  }

  /**
   * A worker refused (or lost) a dispatch before doing any work: nothing
   * happened to the run, so there is nothing to unwind, just a queue slot
   * to give back. Put it at the front rather than the back, so one flaky
   * worker doesn't push a run behind everything queued after it, and leave
   * it there rather than immediately retrying: #dispatchQueued runs again
   * on the next capacity change on its own.
   */
  #onRunRejected(runId: string, reason: string, kind: DispatchRequest["kind"]): void {
    console.warn(`[brevi] dispatch of run ${runId} was rejected: ${reason}`);
    // Dispatching a follow-up releases its reservation (an executing follow-up
    // must not keep blocking attach), but a rejected one never executed: put
    // the reservation back, or the requeued run is rebuilt as a fresh
    // implementation and re-runs the ticket against a PR that already exists.
    if (kind === "follow-up") this.#followUps.add(runId);
    this.store.appendEvent({
      runId,
      ts: new Date().toISOString(),
      type: "log",
      stream: "system",
      text: `dispatch was rejected (${reason}); requeued`,
    });
    if (this.store.get(runId)?.status === "queued" && !this.#queue.includes(runId)) {
      this.#queue.unshift(runId);
    }
  }

  /**
   * A dispatched run's worker went away for good. A restart from scratch is
   * safe (a run only becomes externally visible when its PR opens), so the
   * default is to requeue: but the dead worker may have got as far as pushing
   * the branch and opening the PR without reporting it, and re-running the
   * ticket then means a second PR for the same branch. Check GitHub first and
   * adopt what is there, otherwise put the run back on the queue.
   */
  async #onRunInterrupted(runId: string, reason: string, kind: DispatchRequest["kind"]): Promise<void> {
    await this.#withRunLock(runId, async () => {
      const run = this.store.get(runId);
      if (!run || isTerminal(run.status)) return;
      // A requeued follow-up must not be rebuilt as a fresh implementation
      // against a PR that already exists (same reasoning as #onRunRejected).
      if (kind === "follow-up") this.#followUps.add(runId);
      this.store.appendEvent({
        runId,
        ts: new Date().toISOString(),
        type: "log",
        stream: "system",
        text: `run interrupted: ${reason}`,
      });
      // Close the dangling attempt so the dashboard's attempt list doesn't
      // show one hanging open forever; a no-op if the last attempt already
      // finished.
      await this.store.endAttempt(runId, { outcome: "failed", error: reason });

      const adopted = await this.#adoptedPullRequest(run, kind);
      if (adopted) {
        const current = this.store.get(runId) ?? run;
        await this.store.setStatus(runId, "completed", {
          finishedAt: new Date().toISOString(),
          prUrl: adopted.prUrl,
          prState: adopted.prState,
          result: {
            prUrl: adopted.prUrl,
            branch: adopted.branch,
            summary:
              "The run's worker went away without reporting back, but it had already opened this pull request; brevi adopted it instead of running the ticket again.",
            artifacts: current.result?.artifacts ?? [],
            costTotals: current.result?.costTotals,
          },
        });
        this.#onRunSettled(runId);
        return;
      }

      try {
        await this.#discardRetained(runId);
      } catch (error) {
        // The owning worker is definitionally gone here (that's why this ran
        // at all), so a throw is the expected outcome, not an exceptional
        // one; it must not strand the run "active" forever over a worker
        // that will never reconnect to discard its own retained disk. The
        // reaper's own retry timer (see #maybeReap) keeps trying later.
        console.error(
          `[brevi] failed to discard run ${runId}'s retained sandbox after its worker was lost: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.#clearResume(runId);
      await this.#enqueueForAttempt(runId, reason);
    });
  }

  /**
   * The pull request the *interrupted attempt itself* produced, if any.
   *
   * The bar is deliberately high, because adopting completes the run: the
   * only thing that counts as proof the dead worker finished is a pull
   * request that did not exist when this attempt began and does now. Two
   * things are therefore never adopted, and both requeue instead:
   *
   * - A follow-up. It runs precisely *because* a pull request already
   *   exists, so finding one says nothing about whether this attempt rebased
   *   or addressed any feedback before its worker vanished.
   * - Any pull request created before this attempt started. `run.prUrl`
   *   survives a requeue by design (see Run.prUrl), so a retry carries the
   *   previous attempt's PR, and the branch a ticket maps to is stable
   *   across runs; in both cases the PR predates the attempt and proves
   *   nothing about it.
   *
   * Requeueing when in doubt costs nothing and is always safe: the next
   * attempt pushes the same branch, and opening a PR for a branch that
   * already has one updates the existing PR rather than adding a second (see
   * createPullRequest). Any GitHub failure resolves to undefined for the
   * same reason.
   */
  async #adoptedPullRequest(
    run: Run,
    kind: DispatchRequest["kind"],
  ): Promise<{ prUrl: string; prState: PrState; branch: string } | undefined> {
    if (kind === "follow-up") return undefined;
    const token = this.config.github.token;
    const repo = run.ticket.repo ? this.config.repos[run.ticket.repo] : undefined;
    if (!token || !repo) return undefined;
    const branch = branchNameFor(run.ticket);
    try {
      const found = await findPullRequestForBranch({ remote: repo.remote, branch, token });
      if (!found || !adoptableFromAttempt({ kind, attemptStartedAt: attemptStartOf(run), pr: found })) return undefined;
      return { prUrl: found.url, prState: found.state, branch };
    } catch {
      return undefined;
    }
  }
}
