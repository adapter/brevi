import { EventEmitter } from "node:events";
import {
  CONFIG_PATH,
  redactConfig,
  repoConfigSchema,
  type BreviConfig,
  type ConnectResponse,
  type CredentialProvider,
  type CredentialResult,
  type CredentialsUpdateRequest,
  type CredentialsUpdateResponse,
  type DevicePollResponse,
  type GithubRepo,
  type LinearProject,
  type RepoConfig,
  type ReposUpdateRequest,
  type ReposUpdateResponse,
  type Run,
  type RunEvent,
  type Ticket,
} from "@brevi/shared";
import { createSandboxProvider, type SandboxProvider } from "@brevi/sandbox";
import { saveConfig } from "./config.js";
import {
  discoverAnthropicCredential,
  discoverCodexCredential,
  discoverGithubToken,
  exchangeLinearCode,
  githubClientId,
  hostedApiReachable,
  linearOauthApp,
  pollGithubDeviceFlow,
  startGithubDeviceFlow,
  startLinearOauth,
  type GithubDeviceSession,
  type LinearOauthSession,
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
import { LinearService } from "./linear.js";
import { executeRun } from "./runner.js";
import { ACTIVE_STATUSES, RunStore, isTerminal } from "./state.js";

/** Error with an HTTP-mappable code, thrown by orchestrator commands. */
export class OrchestratorError extends Error {
  constructor(
    readonly code: "not-found" | "conflict" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "OrchestratorError";
  }
}

interface OrchestratorEvents {
  tickets: [Ticket[]];
  config: [BreviConfig];
}

/**
 * Ties everything together: polls Linear on an interval, auto-queues eligible
 * tickets, and executes runs serially (FIFO, one at a time).
 */
export class Orchestrator extends EventEmitter<OrchestratorEvents> {
  readonly store: RunStore;
  readonly config: BreviConfig;

  #configPath: string;
  #linear?: LinearService;
  #provider?: SandboxProvider;
  #tickets: Ticket[] = [];
  #queue: string[] = [];
  #drainPromise?: Promise<void>;
  #activeRunId?: string;
  #abort?: AbortController;
  #pollTimer?: NodeJS.Timeout;
  /** One pending resume timer per run waiting on a usage-limit reset. */
  #resumeTimers = new Map<string, NodeJS.Timeout>();
  #stopped = false;
  #warnedNoRepo = new Set<string>();
  #githubDevice?: GithubDeviceSession;
  #linearOauth?: LinearOauthSession;

  constructor(config: BreviConfig, store: RunStore = new RunStore(), configPath?: string) {
    super();
    this.config = config;
    this.store = store;
    this.#configPath = configPath ?? CONFIG_PATH;
    if (config.linear.apiKey) this.#linear = new LinearService(config);
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

  /** One poll cycle. Never throws; a bad poll must not take the server down. */
  async poll(): Promise<void> {
    if (this.#stopped) return;
    const linear = this.#linear;
    if (!linear) return; // Not connected yet; the dashboard's Connections panel starts us.
    let tickets: Ticket[];
    try {
      tickets = await linear.fetchEligibleTickets();
    } catch (error) {
      console.error(`[brevi] linear poll failed: ${error instanceof Error ? error.message : String(error)}`);
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
    if (ticket.kind === "implementation" && !this.config.github.token) {
      throw new OrchestratorError(
        "invalid",
        "GitHub is not connected: add a token in the dashboard's Connections panel before running implementation tickets",
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
      await saveConfig(this.config, this.#configPath);
      this.emit("config", redactConfig(this.config));
    }
    if (linearChanged) {
      this.#linear = this.config.linear.apiKey ? new LinearService(this.config) : undefined;
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
    await saveConfig(this.config, this.#configPath);
    this.emit("config", redactConfig(this.config));
    if (linearChanged) {
      this.#linear = this.config.linear.apiKey ? new LinearService(this.config) : undefined;
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
      const token = await exchangeLinearCode(session, code);
      const result = await validateLinearApiKey(token);
      if (!result.ok) return result;
      await this.#saveCredential(() => {
        this.config.linear.apiKey = token;
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
    await saveConfig(this.config, this.#configPath);
    this.emit("config", redactConfig(this.config));
    this.#warnedNoRepo.clear();
    void this.poll(); // Tickets may now resolve to a repo.
    return { config: redactConfig(this.config) };
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
    if (this.#activeRunId === runId) {
      this.#abort?.abort();
    }
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

  /** Stop polling and abort any active run. Resolves once the worker settles. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    // Waiting runs stay "waiting" on disk; the next boot reschedules them.
    for (const timer of this.#resumeTimers.values()) clearTimeout(timer);
    this.#resumeTimers.clear();
    this.#abort?.abort();
    // Cancel anything still waiting in the queue so it isn't left "queued" forever.
    for (const id of this.#queue.splice(0)) {
      await this.store
        .setStatus(id, "cancelled", { finishedAt: new Date().toISOString() })
        .catch(() => undefined);
    }
    await this.#drainPromise?.catch(() => undefined);
    await this.store.flush();
  }

  #activeOrQueuedRun(ticketId: string): Run | undefined {
    // "waiting" counts: a run parked on a limit reset still owns its ticket.
    return this.store.runsForTicket(ticketId).find((run) => !isTerminal(run.status));
  }

  /** Put a run back in the queue for its next attempt. */
  async #requeue(runId: string): Promise<Run> {
    this.#clearResume(runId);
    const run = await this.store.setStatus(runId, "queued", { resumeAt: undefined });
    this.#queue.push(runId);
    this.#kickWorker();
    return run;
  }

  #clearResume(runId: string): void {
    const timer = this.#resumeTimers.get(runId);
    if (timer) clearTimeout(timer);
    this.#resumeTimers.delete(runId);
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
    if (ticket.kind === "implementation" && !this.config.github.token) {
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

  #kickWorker(): void {
    if (this.#drainPromise) return;
    this.#drainPromise = this.#drain().finally(() => {
      this.#drainPromise = undefined;
    });
  }

  async #drain(): Promise<void> {
    while (this.#queue.length > 0 && !this.#stopped) {
      const runId = this.#queue.shift();
      if (!runId) break;
      const run = this.store.get(runId);
      if (!run || run.status !== "queued") continue;
      const provider = this.#provider;
      if (!provider) break;
      const linear = this.#linear;
      if (!linear) {
        // Linear was disconnected after this run was queued.
        await this.store
          .setStatus(runId, "failed", {
            error: "Linear was disconnected before the run started",
            finishedAt: new Date().toISOString(),
          })
          .catch(() => undefined);
        continue;
      }
      this.#abort = new AbortController();
      this.#activeRunId = runId;
      try {
        await executeRun({
          runId,
          config: this.config,
          store: this.store,
          provider,
          linear,
          signal: this.#abort.signal,
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
        this.#activeRunId = undefined;
        this.#abort = undefined;
      }
      // An attempt that ended on a usage limit parked the run as waiting;
      // arm the timer that will start the next attempt.
      if (this.store.get(runId)?.status === "waiting") this.#scheduleResume(runId);
    }
  }
}
