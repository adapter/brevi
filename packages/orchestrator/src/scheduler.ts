import { EventEmitter } from "node:events";
import {
  CONFIG_PATH,
  redactConfig,
  type BreviConfig,
  type CredentialResult,
  type CredentialsUpdateRequest,
  type CredentialsUpdateResponse,
  type Run,
  type RunEvent,
  type Ticket,
} from "@brevi/shared";
import { createSandboxProvider, type SandboxProvider } from "@brevi/sandbox";
import { saveConfig } from "./config.js";
import {
  validateAnthropicApiKey,
  validateCodexApiKey,
  validateGithubToken,
  validateLinearApiKey,
} from "./credentials.js";
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
  #stopped = false;
  #warnedNoRepo = new Set<string>();

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
    void this.poll();
    this.#pollTimer = setInterval(() => void this.poll(), this.config.pollIntervalSeconds * 1000);
    this.#pollTimer.unref();
  }

  /** True once a Linear API key is configured. */
  get linearConnected(): boolean {
    return this.#linear !== undefined;
  }

  /** One poll cycle. Never throws — a bad poll must not take the server down. */
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
      }),
      apply(request.codexApiKey, validateCodexApiKey, (key) => {
        this.config.agent.codexApiKey = key;
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

  /** Cancel a queued or active run. Terminal runs are returned unchanged. */
  async cancelRun(runId: string): Promise<Run> {
    const run = this.store.get(runId);
    if (!run) throw new OrchestratorError("not-found", `no run with id ${runId}`);
    if (isTerminal(run.status)) return run;
    if (run.status === "queued") {
      this.#queue = this.#queue.filter((id) => id !== runId);
      return this.store.setStatus(runId, "cancelled", { finishedAt: new Date().toISOString() });
    }
    if (this.#activeRunId === runId) {
      this.#abort?.abort();
    }
    return this.store.get(runId) ?? run;
  }

  /** Stop polling and abort any active run. Resolves once the worker settles. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#pollTimer) clearInterval(this.#pollTimer);
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
    return this.store.runsForTicket(ticketId).find((run) => ACTIVE_STATUSES.has(run.status));
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
    if (previous.some((run) => ACTIVE_STATUSES.has(run.status))) return;
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
    }
  }
}
