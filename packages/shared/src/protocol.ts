import type { BreviConfig, RepoConfig } from "./config.js";
import type { Run, RunEvent, Ticket } from "./types.js";

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
 *   GET  /api/connect/linear/callback    -> HTML (OAuth redirect target; the
 *        server exchanges the code, saves the token, and broadcasts config)
 *   GET  /api/github/repos               -> GithubRepo[]   (repos visible to the
 *        connected GitHub token, most recently pushed first; 400 when GitHub
 *        isn't connected)
 *   PUT  /api/settings/repos             -> ReposUpdateResponse
 *        body: ReposUpdateRequest. Replaces the repo mappings wholesale.
 *   GET  /ws                             -> WebSocket, messages below
 *
 * Everything else serves the built dashboard (SPA fallback to index.html).
 */

export interface HealthResponse {
  ok: boolean;
  version: string;
  sandboxProvider: string;
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

/** Server -> dashboard WebSocket messages. */
export type ServerMessage =
  | { type: "hello"; runs: Run[]; tickets: Ticket[]; config: BreviConfig }
  | { type: "config"; config: BreviConfig }
  | { type: "tickets"; tickets: Ticket[] }
  | { type: "run-updated"; run: Run }
  | { type: "run-event"; event: RunEvent };

/** Dashboard -> server WebSocket messages. */
export type ClientMessage =
  | { type: "subscribe"; runId: string }
  | { type: "unsubscribe"; runId: string };
