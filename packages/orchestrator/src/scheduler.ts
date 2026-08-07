import { EventEmitter } from "node:events";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  CONFIG_PATH,
  redactConfig,
  repoConfigSchema,
  WORKSPACES_DIR,
  type BreviConfig,
  type ConnectResponse,
  type CredentialProvider,
  type CredentialResult,
  type CredentialsUpdateRequest,
  type CredentialsUpdateResponse,
  type DevicePollResponse,
  type GithubRepo,
  type LinearProject,
  type LinearStatus,
  type R2ConnectResponse,
  type R2SettingsUpdateRequest,
  type R2SettingsUpdateResponse,
  type R2Status,
  type RepoConfig,
  type ReposUpdateRequest,
  type ReposUpdateResponse,
  type ResumeRunResponse,
  type Run,
  type RunAttachInfo,
  type RunEvent,
  type SandboxSettingsUpdateRequest,
  type SandboxSettingsUpdateResponse,
  type Ticket,
} from "@brevi/shared";
import { createSandboxProvider, type Sandbox, type SandboxProvider } from "@brevi/sandbox";
import { saveConfig } from "./config.js";
import {
  discoverAnthropicCredential,
  discoverCodexCredential,
  discoverGithubToken,
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
} from "./credentials.js";
import { listRepos } from "./github.js";
import { agentProvider, probeAgentLimit } from "./limits.js";
import { isLinearAuthError, LinearService, type LinearAuthHooks } from "./linear.js";
import { checkWrangler, DEFAULT_EVIDENCE_BUCKET, provisionBucket, startWranglerLogin } from "./r2.js";
import { buildResumeScript } from "./resume.js";
import { collectAgentEnv, executeRun, playwrightBrowsersPath } from "./runner.js";
import { ACTIVE_STATUSES, RunStore, isTerminal } from "./state.js";

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

  #configPath: string;
  #linear?: LinearService;
  #provider?: SandboxProvider;
  #tickets: Ticket[] = [];
  #queue: string[] = [];
  /** Abort controller per run currently executing in a sandbox. */
  #aborts = new Map<string, AbortController>();
  /** Settled when a run's execution finishes; awaited by stop(). */
  #running = new Map<string, Promise<void>>();
  #pollTimer?: NodeJS.Timeout;
  /** One pending resume timer per run waiting on a usage-limit reset. */
  #resumeTimers = new Map<string, NodeJS.Timeout>();
  /**
   * Sandboxes rehydrated for interactive resume, keyed by run id; a promise so
   * concurrent resume calls share one boot. `clients` counts the attach
   * sessions sharing it, so a release only stops the VM when the last one
   * detaches.
   */
  #attached = new Map<string, { pending: Promise<Sandbox>; clients: number }>();
  /** One pending reap timer per run with a retained sandbox, keyed by run id. */
  #reapTimers = new Map<string, NodeJS.Timeout>();
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
  /** Recovery hooks handed to LinearService so every Linear call shares one refresh path. */
  readonly #linearAuth: LinearAuthHooks = {
    recover: () => this.#recoverLinearAuth(),
    rejected: (detail) => this.#enterLinearAuthError(detail),
  };

  constructor(config: BreviConfig, store: RunStore = new RunStore(), configPath?: string) {
    super();
    this.config = config;
    this.store = store;
    this.#configPath = configPath ?? CONFIG_PATH;
    if (config.linear.apiKey) this.#linear = new LinearService(config, this.#linearAuth);
  }

  get providerName(): string {
    return this.#provider?.name ?? this.config.sandbox.provider;
  }

  get tickets(): Ticket[] {
    return this.#tickets;
  }

  listRuns(): Run[] {
    return this.store.list();
  }

  getRun(id: string): Run | undefined {
    return this.store.get(id);
  }

  getRunEvents(id: string): Promise<RunEvent[]> {
    return this.store.readEvents(id);
  }

  /** Load state, boot the sandbox provider, and begin the poll loop. */
  async start(): Promise<void> {
    await this.store.init();
    this.#provider = await createSandboxProvider({
      requested: this.config.sandbox.provider,
      firecracker: this.config.sandbox.firecracker,
    });
    await this.#provider.ensureAvailable();
    // Runs left with a retained sandbox from a previous process pick their
    // reaper back up: a window that already passed is reclaimed right away,
    // otherwise a timer is armed for when it ends.
    for (const run of this.store.list()) {
      const retainedUntil = run.sandbox.retainedUntil;
      if (!retainedUntil) continue;
      if (Date.parse(retainedUntil) <= Date.now()) await this.#reap(run.id);
      else this.#scheduleReap(run.id);
    }
    // Clears workspace dirs left behind by a crashed or interrupted run:
    // store.init() already marked interrupted runs failed, and they carry no
    // retainedUntil, so anything without an active or retained owner is stale.
    await this.#sweepWorkspaces();
    // Runs left waiting on a limit reset by a previous process pick their
    // schedule back up.
    for (const run of this.store.list()) {
      if (run.status === "waiting") this.#scheduleResume(run.id);
    }
    void this.poll();
    this.#pollTimer = setInterval(() => void this.poll(), this.config.pollIntervalSeconds * 1000);
    this.#pollTimer.unref();
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

  /** Manually queue a ticket from the dashboard. */
  async queueTicket(ticketId: string): Promise<Run> {
    const ticket = this.#tickets.find((t) => t.id === ticketId);
    if (!ticket) throw new OrchestratorError("not-found", `no eligible ticket with id ${ticketId}`);
    if (!ticket.repo) {
      throw new OrchestratorError(
        "invalid",
        `ticket ${ticket.identifier} has no repo mapping: add a "repo:<key>" label or set defaultRepo`,
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

    const [linear, github, anthropic, codex] = await Promise.all([
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
    ]);
    if (linear) results.linear = linear;
    if (github) results.github = github;
    if (anthropic) results.anthropic = anthropic;
    if (codex) results.codex = codex;

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
            port: this.config.server.port,
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

  /** Replace the repo mappings from the dashboard and re-resolve tickets. */
  async updateRepos(request: ReposUpdateRequest): Promise<ReposUpdateResponse> {
    const repos: Record<string, RepoConfig> = {};
    for (const [key, value] of Object.entries(request.repos ?? {})) {
      const trimmed = key.trim();
      if (!trimmed) throw new OrchestratorError("invalid", "repo keys must be non-empty");
      const parsed = repoConfigSchema.safeParse(value);
      if (!parsed.success) {
        throw new OrchestratorError(
          "invalid",
          `repo "${trimmed}": ${parsed.error.issues[0]?.message ?? "invalid"}`,
        );
      }
      repos[trimmed] = parsed.data;
    }
    let defaultRepo = request.defaultRepo?.trim() || undefined;
    if (defaultRepo && !repos[defaultRepo]) {
      throw new OrchestratorError("invalid", `defaultRepo "${defaultRepo}" is not a repo key`);
    }
    // Losing the default silently would strand tickets; fall back to any repo.
    if (!defaultRepo) defaultRepo = Object.keys(repos)[0];

    this.config.repos = repos;
    this.config.defaultRepo = defaultRepo;
    await this.#persistConfig();
    this.emit("config", redactConfig(this.config));
    this.#warnedNoRepo.clear();
    void this.poll(); // Tickets may now resolve to a repo.
    return { config: redactConfig(this.config) };
  }

  /** Apply and persist sandbox scheduling settings from the dashboard. */
  async updateSandboxSettings(
    request: SandboxSettingsUpdateRequest,
  ): Promise<SandboxSettingsUpdateResponse> {
    const { concurrency } = request;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
      throw new OrchestratorError("invalid", "sandbox concurrency must be an integer between 1 and 16");
    }
    this.config.sandbox.concurrency = concurrency;
    await this.#persistConfig();
    this.emit("config", redactConfig(this.config));
    // Raising the limit can start queued runs right away; lowering it only
    // affects new starts, already-running sandboxes finish out.
    this.#kickWorker();
    return { config: redactConfig(this.config) };
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

  /** Apply and persist the R2 evidence bucket settings from the dashboard. */
  async updateR2Settings(request: R2SettingsUpdateRequest): Promise<R2SettingsUpdateResponse> {
    // Validate every field before touching the live config: a rejected save
    // must not leave a half-applied state behind for the next run to read.
    const bucket = typeof request.bucket === "string" ? request.bucket.trim() : undefined;
    let publicBaseUrl: string | undefined;
    if (typeof request.publicBaseUrl === "string") {
      const trimmed = request.publicBaseUrl.trim().replace(/\/+$/, "");
      if (trimmed) {
        try {
          const url = new URL(trimmed);
          if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("not http(s)");
        } catch {
          throw new OrchestratorError("invalid", "publicBaseUrl must be an http(s) URL");
        }
      }
      publicBaseUrl = trimmed;
    }
    if (bucket !== undefined) this.config.r2.bucket = bucket;
    if (publicBaseUrl !== undefined) this.config.r2.publicBaseUrl = publicBaseUrl;
    await this.#persistConfig();
    this.emit("config", redactConfig(this.config));
    return { config: redactConfig(this.config), r2: await this.r2Status() };
  }

  /** Cancel a queued, waiting, or active run. Terminal runs are returned unchanged. */
  async cancelRun(runId: string): Promise<Run> {
    const run = this.store.get(runId);
    if (!run) throw new OrchestratorError("not-found", `no run with id ${runId}`);
    if (isTerminal(run.status)) return run;
    if (run.status === "queued") {
      this.#queue = this.#queue.filter((id) => id !== runId);
      return this.store.setStatus(runId, "cancelled", { finishedAt: new Date().toISOString() });
    }
    if (run.status === "waiting") {
      this.#clearResume(runId);
      return this.store.setStatus(runId, "cancelled", {
        finishedAt: new Date().toISOString(),
        resumeAt: undefined,
      });
    }
    this.#aborts.get(runId)?.abort();
    return this.store.get(runId) ?? run;
  }

  /**
   * Manually start a new attempt of a failed, cancelled, or waiting run. For
   * a waiting run this skips the rest of the wait and re-queues immediately.
   */
  async retryRun(runId: string): Promise<Run> {
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
  }

  /**
   * Boot a finished run's retained sandbox back up (if it isn't already) and
   * install a resume script inside it that reattaches the agent conversation.
   * `brevi attach` calls this, then opens the session the returned attach
   * info describes.
   */
  async resumeRun(runId: string): Promise<ResumeRunResponse> {
    const run = this.store.get(runId);
    if (!run) throw new OrchestratorError("not-found", `no run with id ${runId}`);
    if (run.status !== "completed" && run.status !== "failed") {
      throw new OrchestratorError("conflict", `run ${runId} is ${run.status}; only finished runs can be resumed`);
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
    const provider = this.#provider;
    if (!provider || provider.name !== run.sandbox.provider) {
      throw new OrchestratorError(
        "conflict",
        `this run's sandbox provider (${run.sandbox.provider}) is no longer the active one (${provider?.name ?? "none"}); it can't be resumed`,
      );
    }

    let entry = this.#attached.get(runId);
    if (!entry) {
      const pending = (async () => {
        const env = collectAgentEnv(this.config);
        env.PLAYWRIGHT_BROWSERS_PATH = await playwrightBrowsersPath(provider.name);
        return provider.rehydrate({ id: runId, env });
      })();
      entry = { pending, clients: 0 };
      this.#attached.set(runId, entry);
      pending.catch(() => this.#attached.delete(runId)); // a failed boot must not poison later resumes
      this.store.appendEvent({
        runId,
        ts: new Date().toISOString(),
        type: "log",
        stream: "system",
        text: "booting retained sandbox for interactive resume",
      });
    }
    const sandbox = await entry.pending;
    entry.clients += 1;

    // Installed fresh on every resume call: cheap, and keeps credentials
    // current if they changed since the sandbox was retained.
    const env = collectAgentEnv(this.config);
    env.PLAYWRIGHT_BROWSERS_PATH = await playwrightBrowsersPath(provider.name);
    const connection = sandbox.connection();
    // Kept outside the workspace/checkout in both cases, so the script never
    // dirties the run's tree: /root for ssh, alongside (not inside) the
    // workspace dir on the host for the process provider.
    const scriptPath =
      connection.kind === "ssh" ? "/root/brevi-resume.sh" : join(WORKSPACES_DIR, runId, "brevi-resume.sh");
    await sandbox.writeFile(
      scriptPath,
      buildResumeScript({
        workspacePath: sandbox.workspacePath,
        env,
        command: this.config.agent.command,
        sessionId: run.agentSessionId,
      }),
    );
    await sandbox.exec("chmod", ["755", scriptPath]);

    const attach: RunAttachInfo =
      connection.kind === "ssh"
        ? { kind: "ssh", scriptPath, host: connection.host, user: connection.user, keyPath: connection.keyPath }
        : { kind: "local", scriptPath };

    return { run: this.store.get(runId) ?? run, attach };
  }

  /**
   * Detach one resume client; stops the sandbox's compute again (keeping its
   * disk until the retention window ends) once the last client is gone. A
   * no-op when nothing is currently attached.
   */
  async releaseRun(runId: string): Promise<Run> {
    const run = this.store.get(runId);
    if (!run) throw new OrchestratorError("not-found", `no run with id ${runId}`);
    const entry = this.#attached.get(runId);
    if (entry) {
      entry.clients = Math.max(0, entry.clients - 1);
      if (entry.clients > 0) return this.store.get(runId) ?? run;
      this.#attached.delete(runId);
      const sandbox = await entry.pending.catch(() => undefined);
      await sandbox?.release().catch(() => undefined);
      const retainedUntil = this.store.get(runId)?.sandbox.retainedUntil;
      if (retainedUntil) {
        this.store.appendEvent({
          runId,
          ts: new Date().toISOString(),
          type: "log",
          stream: "system",
          text: `sandbox released; disk retained until ${retainedUntil}`,
        });
      }
    }
    return this.store.get(runId) ?? run;
  }

  /** Stop polling and abort any active run. Resolves once the worker settles. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    // Waiting runs stay "waiting" on disk; the next boot reschedules them.
    for (const timer of this.#resumeTimers.values()) clearTimeout(timer);
    this.#resumeTimers.clear();
    for (const abort of this.#aborts.values()) abort.abort();
    // Cancel anything still waiting in the queue so it isn't left "queued" forever.
    for (const id of this.#queue.splice(0)) {
      await this.store
        .setStatus(id, "cancelled", { finishedAt: new Date().toISOString() })
        .catch(() => undefined);
    }
    await Promise.allSettled(this.#running.values());
    for (const timer of this.#reapTimers.values()) clearTimeout(timer);
    this.#reapTimers.clear();
    for (const entry of this.#attached.values()) {
      const sandbox = await entry.pending.catch(() => undefined);
      await sandbox?.release().catch(() => undefined);
    }
    this.#attached.clear();
    // Expired and untracked workspace dirs go; unexpired retained disks
    // survive so the resume window persists across restarts.
    await this.#sweepWorkspaces();
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
    const write = this.#configWrite.then(() => saveConfig(this.config, this.#configPath));
    // Keep the chain alive after a failed write; only the caller sees the error.
    this.#configWrite = write.catch(() => undefined);
    return write.then(() => undefined);
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

  /** Put a run back in the queue for its next attempt. */
  async #requeue(runId: string): Promise<Run> {
    this.#clearResume(runId);
    // A retry starts from a fresh checkout, so any sandbox retained from the
    // previous attempt is stale before it's ever used again; discard it now
    // rather than let it linger until its own retention window ends.
    await this.#discardRetained(runId);
    // Shed the previous attempt's outcome right away rather than at the
    // "preparing" transition: the queued snapshot goes straight to clients,
    // and a stale result/error would keep the dashboard's Result tab alive
    // for as long as the run waits for a free worker.
    const run = await this.store.setStatus(runId, "queued", {
      resumeAt: undefined,
      queuedAt: new Date().toISOString(),
      finishedAt: undefined,
      error: undefined,
      limit: undefined,
      result: undefined,
    });
    this.#queue.push(runId);
    this.#kickWorker();
    return run;
  }

  #clearResume(runId: string): void {
    const timer = this.#resumeTimers.get(runId);
    if (timer) clearTimeout(timer);
    this.#resumeTimers.delete(runId);
  }

  /**
   * Tear down a run's retained sandbox: an already-attached (rehydrated)
   * instance is destroyed directly, otherwise the provider is asked to
   * discard the disk. Shared by the reaper (retention window expired) and
   * requeue (a retry makes any retained disk stale immediately).
   */
  async #discardRetained(runId: string): Promise<void> {
    const timer = this.#reapTimers.get(runId);
    if (timer) clearTimeout(timer);
    this.#reapTimers.delete(runId);

    const entry = this.#attached.get(runId);
    if (entry) {
      this.#attached.delete(runId);
      const sandbox = await entry.pending.catch(() => undefined);
      await sandbox?.destroy().catch(() => undefined);
    } else if (this.store.get(runId)?.sandbox.retainedUntil) {
      await this.#provider?.discard(runId).catch(() => undefined);
    }

    const run = this.store.get(runId);
    if (run?.sandbox.retainedUntil) {
      await this.store.update(runId, { sandbox: { ...run.sandbox, retainedUntil: undefined } });
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

  /**
   * Run workspaces are ephemeral except while a run is active or its sandbox
   * is retained; delete anything else left behind under WORKSPACES_DIR
   * (a crash, an interrupted retry, a provider that never got to clean up).
   */
  async #sweepWorkspaces(): Promise<void> {
    let entries;
    try {
      entries = await readdir(WORKSPACES_DIR, { withFileTypes: true });
    } catch {
      return; // nothing to sweep
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runId = entry.name;
      const run = this.store.get(runId);
      const retainedUntil = run?.sandbox.retainedUntil;
      const retained = retainedUntil !== undefined && Date.parse(retainedUntil) > Date.now();
      if (run && (ACTIVE_STATUSES.has(run.status) || retained)) continue;
      console.log(`[brevi] removed leftover sandbox workspace ${runId}`);
      await rm(join(WORKSPACES_DIR, runId), { recursive: true, force: true }).catch(() => undefined);
    }
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
      await this.#requeue(runId);
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
          `[brevi] ${ticket.identifier} is eligible but has no repo mapping; add a "repo:<key>" label, name its project after a repo key, or set defaultRepo. It will not run automatically.`,
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

  async #enqueue(ticket: Ticket): Promise<Run> {
    const provider = this.#provider;
    if (!provider) throw new Error("orchestrator not started");
    const run = await this.store.createRun(ticket, provider.name);
    this.#queue.push(run.id);
    this.#kickWorker();
    return run;
  }

  /** Start queued runs until the concurrency limit is reached. */
  #kickWorker(): void {
    if (this.#stopped) return;
    const limit = Math.max(1, this.config.sandbox.concurrency);
    while (this.#running.size < limit && this.#queue.length > 0) {
      const runId = this.#queue.shift();
      if (!runId) break;
      const run = this.store.get(runId);
      if (!run || run.status !== "queued") continue;
      const promise = this.#execute(runId).finally(() => {
        this.#running.delete(runId);
        this.#kickWorker();
      });
      this.#running.set(runId, promise);
    }
  }

  async #execute(runId: string): Promise<void> {
    const provider = this.#provider;
    if (!provider) {
      // Only possible before start(); leave the run queued for the next kick.
      this.#queue.unshift(runId);
      return;
    }
    const linear = this.#linear;
    if (!linear) {
      // Linear was disconnected after this run was queued.
      await this.store
        .setStatus(runId, "failed", {
          error: "Linear was disconnected before the run started",
          finishedAt: new Date().toISOString(),
        })
        .catch(() => undefined);
      return;
    }
    const abort = new AbortController();
    this.#aborts.set(runId, abort);
    try {
      await executeRun({
        runId,
        config: this.config,
        store: this.store,
        provider,
        linear,
        signal: abort.signal,
      });
    } catch (error) {
      // executeRun handles its own failures; this is a last line of defense.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[brevi] run ${runId} crashed: ${message}`);
      const current = this.store.get(runId);
      if (current && !isTerminal(current.status)) {
        await this.store
          .setStatus(runId, "failed", { error: message, finishedAt: new Date().toISOString() })
          .catch(() => undefined);
      }
    } finally {
      this.#aborts.delete(runId);
    }
    // An attempt that ended on a usage limit parked the run as waiting;
    // arm the timer that will start the next attempt.
    if (this.store.get(runId)?.status === "waiting") this.#scheduleResume(runId);
    // A completed/failed attempt that retained its sandbox needs a reaper
    // armed for when the retention window ends.
    if (this.store.get(runId)?.sandbox.retainedUntil) this.#scheduleReap(runId);
  }
}
