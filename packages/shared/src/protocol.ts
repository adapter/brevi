import type { BreviConfig, RepoConfig } from "./config.js";
import type { Run, RunEvent, Ticket } from "./types.js";
import type { FirecrackerVmSize } from "./sizes.js";

/**
 * HTTP API served by the orchestrator (default port 4400):
 *
 *   GET  /api/health                     -> { ok: true, version: string }
 *   GET  /api/config                     -> redacted BreviConfig
 *   GET  /api/tickets                    -> Ticket[]        (current eligible queue)
 *   GET  /api/runs                       -> Run[]           (newest first)
 *   GET  /api/runs/:id                   -> Run
 *   GET  /api/runs/:id/events            -> RunEvent[]      (full history)
 *   GET  /api/runs/:id/artifacts/:name   -> raw artifact bytes
 *   POST /api/tickets/:id/run            -> Run             (manually queue a ticket)
 *   POST /api/runs/:id/cancel            -> Run
 *   POST /api/runs/:id/retry             -> Run
 *        Start a new attempt of a failed, cancelled, or waiting run. A waiting
 *        run resumes immediately instead of waiting for its limit to lift.
 *   POST /api/runs/:id/followup          -> Run
 *        Start a follow-up on a completed run's open PR: rebase onto the
 *        latest base, address review feedback, push with force-with-lease,
 *        and post a summary comment. 409 while another execution is active or
 *        when the PR is merged/closed.
 *   GET  /api/runs/:id/pr                -> PrStatusResponse
 *        Open/merged/closed state of the run's PR, for the dashboard's
 *        follow-up button.
 *   POST /api/runs/:id/resume            -> ResumeRunResponse
 *        Boot the run's retained sandbox back up (when needed) and prepare an
 *        interactive `claude --resume` session inside it; `brevi attach` calls
 *        this and opens the returned session. 410 once the retention window
 *        has passed and the disk was reclaimed.
 *   POST /api/runs/:id/release           -> Run
 *        Stop the resumed sandbox's compute again, keeping its disk until the
 *        retention window ends. Called by `brevi attach` on detach; a no-op
 *        when nothing is booted.
 *   WS   /ws/runs/:id/attach             -> AttachServerMessage / AttachClientMessage
 *        Web-terminal bridge for the dashboard: booting the retained sandbox
 *        and releasing it on disconnect happen server-side, so this works
 *        when the orchestrator runs on a different machine than the browser.
 *   PUT  /api/settings/credentials       -> CredentialsUpdateResponse
 *        body: CredentialsUpdateRequest. Each provided key is validated against
 *        its provider before being saved; invalid keys are rejected per-field
 *        and valid ones in the same request are still applied.
 *   POST /api/connect/:provider          -> ConnectResponse
 *        One-click connect. Tries automatic strategies first (host credential
 *        discovery, gh CLI, OAuth device/redirect flows) and reports what the
 *        dashboard should do next; "manual" means show the key input.
 *   POST /api/connect/github/poll        -> DevicePollResponse
 *        Poll an in-flight GitHub device authorization.
 *   GET  /api/connect/r2                 -> R2Status
 *        Live state of the Cloudflare R2 evidence connector: is wrangler
 *        installed and logged in, and is a bucket configured.
 *   POST /api/connect/r2                 -> R2ConnectResponse
 *        One-click connect. Logged out: starts `wrangler login` on the host
 *        (interactive OAuth in the browser); the dashboard polls
 *        GET /api/connect/r2 until logged in, then calls this again. Logged
 *        in with no bucket configured: provisions automatically (creates the
 *        default evidence bucket and enables its r2.dev public URL; a
 *        pre-existing bucket is reused only when already public) and
 *        persists the result to config. Already configured: reports
 *        connected without touching anything.
 *   PUT  /api/settings/r2                -> R2SettingsUpdateResponse
 *        body: R2SettingsUpdateRequest. Sets the evidence bucket and its
 *        public base URL.
 *   GET  /api/connect/linear/callback    -> HTML (OAuth redirect target; the
 *        server exchanges the code, saves the token, and broadcasts config)
 *   GET  /api/github/repos               -> GithubRepo[]   (repos visible to the
 *        connected GitHub token, most recently pushed first; 400 when GitHub
 *        isn't connected)
 *   PUT  /api/settings/repos             -> ReposUpdateResponse
 *        body: ReposUpdateRequest. Replaces the repo mappings wholesale.
 *   PUT  /api/settings/sandbox           -> SandboxSettingsUpdateResponse
 *        body: SandboxSettingsUpdateRequest. Sets how many sandboxed runs may
 *        execute at once and/or the Firecracker VM size preset; persisted to
 *        the config file and applied without a restart (the size preset
 *        applies to newly booted VMs).
 *   GET  /ws                             -> WebSocket, messages below
 *
 * Everything else serves the built dashboard (SPA fallback to index.html).
 */

export interface HealthResponse {
  ok: boolean;
  version: string;
  sandboxProvider: string;
  /**
   * Total host memory in MiB, for the dashboard's capacity hint. Absent from
   * older orchestrators.
   */
  hostMemMib?: number;
}

/**
 * Runtime shape check for /api/health payloads, for callers that must confirm
 * a listener really is the brevi server before acting on it.
 */
export function isHealthResponse(value: unknown): value is HealthResponse {
  if (typeof value !== "object" || value === null) return false;
  const health = value as Record<string, unknown>;
  return (
    typeof health.ok === "boolean" &&
    typeof health.version === "string" &&
    typeof health.sandboxProvider === "string"
  );
}

/** Credential providers configurable from the dashboard. */
export type CredentialProvider = "linear" | "github" | "anthropic" | "codex";

/** Only provided fields are touched; empty string disconnects that provider. */
export interface CredentialsUpdateRequest {
  linearApiKey?: string;
  githubToken?: string;
  anthropicApiKey?: string;
  codexApiKey?: string;
}

export interface CredentialResult {
  ok: boolean;
  /** "Connected as Jane" on success, the validation failure otherwise. */
  detail: string;
}

export interface CredentialsUpdateResponse {
  /** One entry per provider present in the request. */
  results: Partial<Record<CredentialProvider, CredentialResult>>;
  /** Redacted config after applying the valid keys. */
  config: BreviConfig;
}

/** Result of a one-click connect attempt. */
export type ConnectResponse =
  | {
      /** A credential was found (or granted) and verified; it is saved. */
      status: "connected";
      provider: CredentialProvider;
      /** e.g. "Connected as jane (via gh CLI)" or "Verified with claude-haiku-4-5". */
      detail: string;
      config: BreviConfig;
    }
  | {
      /** GitHub device flow started: show the code, open the url, then poll. */
      status: "device";
      provider: "github";
      userCode: string;
      verificationUri: string;
      /** Seconds between polls. */
      interval: number;
      expiresIn: number;
    }
  | {
      /** OAuth redirect flow: open this url; the server finishes via callback. */
      status: "redirect";
      provider: "linear";
      url: string;
    }
  | {
      /** No automatic path available; the dashboard should offer manual entry. */
      status: "manual";
      provider: CredentialProvider;
      reason: string;
    };

export type DevicePollResponse =
  | { status: "pending" }
  | { status: "connected"; detail: string; config: BreviConfig }
  | { status: "error"; detail: string };

/**
 * Live state of the Cloudflare R2 evidence connector. There is no stored
 * credential: authentication lives with the host's wrangler CLI, so this is
 * probed via `wrangler whoami` on every request.
 */
export interface R2Status {
  /** The wrangler CLI is available on the host. */
  installed: boolean;
  /** `wrangler whoami` reports an authenticated identity. */
  loggedIn: boolean;
  /** Account email reported by `wrangler whoami`, when logged in. */
  account?: string;
  /** Configured bucket (config.r2.bucket); empty = not configured. */
  bucket: string;
  /** Configured public base URL (config.r2.publicBaseUrl); empty = not configured. */
  publicBaseUrl: string;
  /** True when installed, logged in, and bucket + public base URL are set. */
  ready: boolean;
}

/** Result of a one-click R2 connect attempt. */
export type R2ConnectResponse =
  | {
      /**
       * Wrangler is authenticated and a bucket is configured. When the
       * bucket or public URL were unset, they were just provisioned (bucket
       * created or reused, r2.dev URL enabled) and saved to config.
       */
      status: "connected";
      r2: R2Status;
    }
  | {
      /**
       * `wrangler login` was started on the host and is opening a browser.
       * Poll GET /api/connect/r2 until loggedIn flips, then POST again to
       * provision the bucket.
       */
      status: "login-started";
      detail: string;
    }
  | {
      /**
       * Wrangler is logged in but automatic provisioning failed (bucket
       * create or dev-url enable rejected, or the bucket pre-exists without
       * public access, which brevi refuses to enable on its own). Config was
       * left untouched; the dashboard should surface the reason and offer
       * manual entry.
       */
      status: "provision-failed";
      reason: string;
      r2: R2Status;
    }
  | {
      /** No automatic path (wrangler missing); reason says what to install. */
      status: "unavailable";
      reason: string;
    };

/** Only provided fields are touched; empty string clears that field. */
export interface R2SettingsUpdateRequest {
  bucket?: string;
  publicBaseUrl?: string;
}

export interface R2SettingsUpdateResponse {
  /** Redacted config after the update. */
  config: BreviConfig;
  /** Live connector state after the update. */
  r2: R2Status;
}

/** A Linear project visible to the connected credential, for the repo mapping picker. */
export interface LinearProject {
  id: string;
  name: string;
}

/** A repository visible to the connected GitHub token. */
export interface GithubRepo {
  /** "owner/name". */
  fullName: string;
  defaultBranch: string;
  private: boolean;
  description: string;
  /** ISO timestamp of the last push. */
  pushedAt: string;
}

/** Replaces config.repos and defaultRepo wholesale. */
export interface ReposUpdateRequest {
  repos: Record<string, RepoConfig>;
  defaultRepo?: string;
}

export interface ReposUpdateResponse {
  /** Redacted config after the update. */
  config: BreviConfig;
}

/** Live state of the pull request a completed run opened, probed from GitHub on demand. */
export interface PrStatusResponse {
  url: string;
  number: number;
  state: "open" | "merged" | "closed";
}

/** How `brevi attach` opens the interactive session a resume prepared. */
export type RunAttachInfo =
  | {
      /** Process sandbox: run the script directly on the host. */
      kind: "local";
      /** Host path of the script that starts the resumed agent session. */
      scriptPath: string;
    }
  | {
      /** Firecracker sandbox: run the script in the guest over ssh. */
      kind: "ssh";
      /** Guest path of the script that starts the resumed agent session. */
      scriptPath: string;
      host: string;
      user: string;
      /** Host path of the ssh private key. */
      keyPath: string;
    };

export interface ResumeRunResponse {
  run: Run;
  attach: RunAttachInfo;
}

/**
 * Sandbox scheduling settings adjustable from the dashboard. At least one
 * field must be provided.
 */
export interface SandboxSettingsUpdateRequest {
  /** How many sandboxed runs may execute at once (1 to 16). */
  concurrency?: number;
  /**
   * Firecracker VM size preset for newly booted VMs. Setting this clears any
   * explicit vcpus/memMib overrides in the config file so the preset
   * actually applies.
   */
  size?: FirecrackerVmSize;
}

export interface SandboxSettingsUpdateResponse {
  /** Redacted config after the update. */
  config: BreviConfig;
}

/**
 * Live state of the Linear connector, beyond "a key is stored".
 * "auth-error" means the stored credential no longer authenticates and could
 * not be refreshed; polling is paused until the user reconnects.
 * "refresh-failing" means the OAuth access token has expired and refreshing
 * it keeps failing for a retryable reason (network, 5xx, rate limit);
 * polling is paused but brevi retries the refresh on its own and resumes
 * without user action once one succeeds.
 */
export interface LinearStatus {
  state: "disconnected" | "connected" | "auth-error" | "refresh-failing";
  /** Why authentication or the refresh failed, absent when healthy. */
  error?: string;
}

/** Server -> dashboard WebSocket messages. */
export type ServerMessage =
  | { type: "hello"; runs: Run[]; tickets: Ticket[]; config: BreviConfig; linearStatus: LinearStatus }
  | { type: "config"; config: BreviConfig }
  | { type: "tickets"; tickets: Ticket[] }
  | { type: "run-updated"; run: Run }
  | { type: "run-event"; event: RunEvent }
  | { type: "linear-status"; linearStatus: LinearStatus };

/** Dashboard -> server WebSocket messages. */
export type ClientMessage =
  | { type: "subscribe"; runId: string }
  | { type: "unsubscribe"; runId: string };

/**
 * Messages on the interactive attach socket (`/ws/runs/:id/attach`), which
 * bridges the dashboard's web terminal to a PTY running the run's resume
 * session inside its retained sandbox. Terminal bytes travel as UTF-8 strings.
 */
export type AttachServerMessage =
  | { type: "data"; data: string }
  | { type: "exit"; code: number }
  | { type: "error"; message: string };

export type AttachClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };
