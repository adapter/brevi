import { z } from "zod";

/**
 * The zod schema for `~/.brevi/config.json`, and the single source of truth
 * for validating it. The dashboard imports this module to validate its
 * settings forms with the exact rules the orchestrator applies, so it must
 * stay free of node builtins: host paths live in `paths.ts` instead, and any
 * default that depends on one is left empty here and resolved at use time.
 */

export const DEFAULT_PORT = 4400;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_FLEET_PORT = 4410;
/**
 * Largest sandbox.concurrency a stored config accepts, and the ceiling the Linux
 * worker installer validates its own `--concurrency` against (CI keeps the two
 * numbers in step, since a shell script cannot import this one). Distinct from
 * WORKER_MAX_CONCURRENCY (worker.ts, 64), which is the wire protocol's
 * registration ceiling; this is what a single machine's sandbox provider is
 * expected to run at once.
 */
export const MAX_SANDBOX_CONCURRENCY = 16;

/**
 * Current ~/.brevi/config.json migration stamp. Stored configs materialize
 * every schema default, so changing a default cannot reach existing installs
 * on its own; loadConfig (packages/orchestrator) rewrites stale stored
 * defaults for files stamped below this version, then stamps them current.
 * v1: pollIntervalSeconds default dropped from 60 to 15.
 */
export const CONFIG_VERSION = 1;

export const repoConfigSchema = z.object({
  /** Git remote in "owner/name" form. */
  remote: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'expected "owner/name"'),
  defaultBranch: z.string().default("main"),
  /** Linear project names whose tickets run against this repo (case-insensitive). */
  projects: z.array(z.string()).default([]),
  /** Optional local checkout to clone from instead of the network. */
  path: z.string().optional(),
  /** Command that produces a runnable dev server, used for demo capture. */
  devCommand: z.string().optional(),
  /** URL the dev server listens on once up, used for demo capture. */
  devUrl: z.string().optional(),
  /**
   * How much demo evidence implementation runs must capture. "always" is the
   * full dev-server/screenshot flow, "auto" lets the agent downgrade to cheap
   * evidence (test output, a CLI transcript) for docs-only or test-only
   * changes, "never" skips the demo requirement entirely.
   */
  demo: z.enum(["always", "auto", "never"]).default("auto"),
});

export const configSchema = z.object({
  linear: z
    .object({
      /** Empty = not connected yet; set via the dashboard's Connections panel. */
      apiKey: z.string().default(""),
      /**
       * OAuth refresh token captured by the Connect flow; empty for plain
       * `lin_api_` keys. Defaulted so older config files keep parsing.
       */
      refreshToken: z.string().default(""),
      /**
       * ISO timestamp the OAuth access token expires at; empty when unknown
       * or when the key never expires. Defaulted so older config files keep
       * parsing.
       */
      tokenExpiresAt: z.string().default(""),
      /** Restrict polling to these team keys (e.g. ["ENG"]). Empty = all teams. */
      teamKeys: z.array(z.string()).default([]),
    })
    .prefault({}),
  github: z
    .object({
      /** Empty = not connected yet; set via the dashboard's Connections panel. */
      token: z.string().default(""),
    })
    .prefault({}),
  /**
   * Cloudflare R2 evidence uploads. Authentication and uploads go through the
   * host's wrangler CLI (`wrangler login` / `wrangler r2 object put`); no
   * credential is stored here. Both fields must be set for uploads to happen.
   */
  r2: z
    .object({
      /** Public R2 bucket demo evidence is uploaded to. Empty = uploads disabled. */
      bucket: z
        .string()
        .default("")
        .transform((value) => value.trim()),
      /**
       * Public base URL the bucket is served from (its r2.dev development URL
       * or a custom domain), used verbatim to build the asset links embedded
       * in PR descriptions. Normalized here rather than at each call site: a
       * trailing slash would show up as "//" in every PR link.
       */
      publicBaseUrl: z
        .string()
        .default("")
        .transform((value) => value.trim().replace(/\/+$/, ""))
        .refine((value) => value === "" || /^https?:\/\/\S+$/.test(value), {
          message: "must be an http(s) URL",
        }),
    })
    .prefault({}),
  /** Map of repo key -> repo config. Ticket labels or project names select the key. */
  repos: z.record(z.string(), repoConfigSchema).prefault({}),
  agent: z
    .object({
      /**
       * Coding agent CLI brevi executes. It has to be on the worker host's
       * PATH (bwrap bind-mounts the host binaries into the sandbox). For
       * Claude it names the executable handed to the Agent SDK as the
       * Claude Code binary; for Codex/Grok it is executed directly.
       */
      command: z.string().default("claude"),
      /**
       * Extra arguments. For Claude runs these are mapped onto the Agent
       * SDK's extra CLI arguments (flag/value or bare-flag pairs only;
       * positional tokens are skipped with a run log line). For Codex/Grok
       * they are appended verbatim after brevi's own arguments.
       */
      args: z.array(z.string()).default([]),
      /**
       * When set, runs everything on this one model with no subagent
       * delegation, overriding the two models below.
       */
      model: z.string().optional(),
      /**
       * Model the main agent loop runs on: it plans, reviews, and delegates
       * implementation to subagents. Claude agents only; Codex runs use
       * `model`.
       */
      orchestratorModel: z.string().default("claude-fable-5"),
      /** Model for the `implementer` subagent that executes the coding tasks. */
      implementModel: z.string().default("claude-sonnet-5"),
      /**
       * Reasoning effort for the main agent loop, passed to Claude Code as
       * `--effort`. Claude agents only; the implementer subagent keeps the
       * CLI's default effort.
       */
      orchestratorEffort: z.enum(["low", "medium", "high"]).default("high"),
      /** Passed to the sandboxed agent as ANTHROPIC_API_KEY. Empty = use host env. */
      anthropicApiKey: z.string().default(""),
      /** Claude Code OAuth token (host-discovered), passed as CLAUDE_CODE_OAUTH_TOKEN. */
      claudeCodeOauthToken: z.string().default(""),
      /** Passed to the sandboxed agent as OPENAI_API_KEY (for Codex agents). */
      codexApiKey: z.string().default(""),
      /**
       * Codex CLI ChatGPT login (the contents of ~/.codex/auth.json), for
       * accounts without an API key. Mounted into the sandbox via CODEX_HOME.
       */
      codexAuthJson: z.string().default(""),
      /** Passed to the sandboxed agent as XAI_API_KEY (for Grok agents). */
      xaiApiKey: z.string().default(""),
      /**
       * Grok CLI login (the contents of ~/.grok/auth.json), for accounts
       * without an API key. Mounted into the sandbox via GROK_HOME.
       */
      grokAuthJson: z.string().default(""),
      /**
       * Adversarial Codex review of implementation runs: after the coding
       * agent finishes, parallel Codex reviewers judge the diff against the
       * ticket and the codebase, and confirmed findings trigger a fix pass
       * before the PR opens. Requires a Codex credential (codexApiKey or
       * codexAuthJson); without one the review is skipped even when true.
       */
      codexReview: z.boolean().default(true),
      /** Model the Codex review runs on. */
      reviewModel: z.string().default("gpt-5.6-sol"),
      /** Reasoning effort for Codex review executions (model_reasoning_effort). */
      reviewEffort: z.enum(["minimal", "low", "medium", "high"]).default("high"),
    })
    .prefault({}),
  /**
   * Repository memories: durable facts a run learns about a repo (where a
   * concern lives, the command that actually builds it, a convention that is
   * easy to get wrong). They are kept on the host under ~/.brevi/memories,
   * outside any sandbox, and injected into the next run's prompt so a fresh
   * sandbox does not re-pay the exploration cost of the last one.
   */
  memory: z
    .object({
      /** Inject stored memories into run prompts and harvest new ones afterwards. */
      enabled: z.boolean().default(true),
      /**
       * How many memories are kept per repo. Once full, the least recently
       * recorded ones are dropped.
       */
      maxEntries: z.number().int().min(1).max(500).default(60),
      /**
       * Character budget for the memories block injected into a prompt. The
       * prompt travels as a single argv element, and the block only pays for
       * itself while it stays smaller than the exploration it replaces.
       */
      maxChars: z.number().int().min(200).max(50_000).default(8000),
    })
    .prefault({}),
  sandbox: z
    .object({
      /**
       * How many sandboxed runs may execute at once. Read by the worker that
       * executes runs: each worker reads its own copy from its own
       * `~/.brevi/config.json` and caps its own concurrency with it.
       */
      concurrency: z.number().int().min(1).max(MAX_SANDBOX_CONCURRENCY).default(1),
      /**
       * Hard wall-clock limit applied per agent execution, not per run: the
       * implementation pass, each Codex reviewer, the synthesis pass, and the
       * fix pass each get their own budget. Defaults to 4 hours per
       * execution.
       */
      timeoutMinutes: z.number().int().min(1).default(240),
      /**
       * How many hours a finished (completed or failed) run's sandbox disk is
       * kept for interactive resume via the desktop terminal. While retained the
       * sandbox consumes only disk, no memory or CPU. 0 disables retention.
       */
      retentionHours: z.number().min(0).default(24),
    })
    .prefault({}),
  /**
   * The fleet: the pool of `brevi worker` daemons that dial into this host
   * and execute runs. The host itself is a pure scheduler, it holds the run
   * store, polls Linear, and opens PRs, but every run's sandbox lives on a
   * connected worker, never on the host process. See worker.ts for the wire
   * protocol workers speak once enrolled, and fleet.ts for enrollment itself.
   *
   * Which machines are enrolled is not configured here: workers are runtime
   * state, so they live in `~/.brevi/fleet.json` (see FleetStore), and their
   * credentials are minted rather than written by hand.
   */
  fleet: z
    .object({
      /**
       * Bind address for the worker channel's own listener, separate from the
       * dashboard's `server` listener on purpose: the dashboard serves the
       * unauthenticated management API (pairing, rename, drain, enable,
       * revoke), so exposing it to the network would let any reachable peer
       * mint a pairing token and enroll its own worker. The worker channel is
       * authenticated (a single-use pairing token, then a durable per-worker
       * credential), so it can safely bind wider without widening that API.
       *
       * Empty (the default) means this listener is off, so only this machine
       * can enroll a worker, over the dashboard's own WORKER_WS_PATH upgrade.
       */
      host: z.string().default(""),
      /** That listener's port; deliberately separate from `server.port`. */
      port: z.number().int().min(1).max(65535).default(DEFAULT_FLEET_PORT),
      /**
       * Seconds a connected worker may go silent before the host drops it and
       * fails its in-flight runs. Workers heartbeat every 15s
       * (WORKER_HEARTBEAT_MS), so the floor here is two intervals: a timeout at
       * or near one interval makes the watchdog and the heartbeat come due
       * together, and ordinary event-loop or network jitter is then enough to
       * drop a perfectly healthy worker.
       */
      heartbeatTimeoutSeconds: z.number().int().min(30).max(600).default(45),
      /** How long a worker that dropped mid-run has to reconnect and resume reporting before its runs are failed. */
      reconnectGraceSeconds: z.number().int().min(10).max(3600).default(120),
    })
    .prefault({}),
  /** OAuth app settings powering the dashboard's one-click Connect flows. */
  connect: z
    .object({
      /**
       * brevi's hosted OAuth backend, used when no personal OAuth app is
       * configured below. Point at your own deployment of apps/api to
       * self-host; empty disables hosted flows entirely.
       */
      apiBase: z.string().default("https://api.brevi.dev"),
      /** Personal GitHub OAuth app client id (device flow), overrides apiBase. */
      githubClientId: z.string().default(""),
      /** Personal Linear OAuth app credentials (redirect flow), override apiBase. */
      linearClientId: z.string().default(""),
      linearClientSecret: z.string().default(""),
    })
    .prefault({}),
  trigger: z
    .object({
      /** Label name that opts a ticket in. */
      label: z.string().default("brevi"),
    })
    .prefault({}),
  /**
   * When finished runs leave the dashboard's default list on their own.
   * Archived runs are hidden, not deleted: every run keeps its directory
   * under ~/.brevi/runs and can be unarchived from the dashboard. Each rule
   * is a day count; 0 disables that rule.
   */
  archive: z
    .object({
      /** Days after a run finishes before it auto-archives, whatever became of its PR or ticket. */
      afterDays: z.number().min(0).default(30),
      /** Days after a run's pull request merges before it auto-archives. */
      mergedAfterDays: z.number().min(0).default(7),
      /** Days after a run's Linear ticket completes or cancels before it auto-archives. */
      closedTicketAfterDays: z.number().min(0).default(7),
    })
    .prefault({}),
  restart: z
    .object({
      /** Automatically wait out agent usage limits and start a new attempt. */
      auto: z.boolean().default(true),
      /** Cap on agent executions per run, counting the first. */
      maxAttempts: z.number().int().min(1).default(5),
      /**
       * Minutes between liveness probes while waiting on a limit whose reset
       * time the agent didn't report (and after a probe that is still limited).
       */
      probeIntervalMinutes: z.number().int().min(1).default(15),
    })
    .prefault({}),
  server: z
    .object({
      port: z.number().int().min(1).max(65535).default(DEFAULT_PORT),
      /**
       * Bind address. The default keeps the dashboard loopback-only; "0.0.0.0"
       * exposes the unauthenticated dashboard and API to the whole network.
       */
      host: z.string().default(DEFAULT_HOST),
    })
    .prefault({}),
  /**
   * How often the orchestrator polls Linear for eligible tickets. Kept low
   * by default so a newly labeled ticket starts within roughly one interval.
   */
  pollIntervalSeconds: z.number().int().min(10).default(15),
  /**
   * Migration stamp (see CONFIG_VERSION). Not a setting: deliberately absent
   * from the /config forms, and defaulted so fresh saves are stamped current.
   */
  configVersion: z.number().int().min(0).default(CONFIG_VERSION),
});

export type BreviConfig = z.infer<typeof configSchema>;
export type RepoConfig = z.infer<typeof repoConfigSchema>;

/** Mask a secret when set; keep "" so clients can tell "not connected" apart. */
function mask(secret: string): string {
  return secret ? "***" : "";
}

/** Config with secrets stripped, safe to send to the dashboard. */
export function redactConfig(config: BreviConfig): BreviConfig {
  return {
    ...config,
    linear: {
      ...config.linear,
      apiKey: mask(config.linear.apiKey),
      refreshToken: mask(config.linear.refreshToken),
    },
    github: { ...config.github, token: mask(config.github.token) },
    agent: {
      ...config.agent,
      anthropicApiKey: mask(config.agent.anthropicApiKey),
      claudeCodeOauthToken: mask(config.agent.claudeCodeOauthToken),
      codexApiKey: mask(config.agent.codexApiKey),
      codexAuthJson: mask(config.agent.codexAuthJson),
      xaiApiKey: mask(config.agent.xaiApiKey),
      grokAuthJson: mask(config.agent.grokAuthJson),
    },
    connect: { ...config.connect, linearClientSecret: mask(config.connect.linearClientSecret) },
    // `fleet` holds no secret to mask: enrollment credentials are minted, not
    // configured, and live in ~/.brevi/fleet.json as hashes (see FleetStore).
  };
}
