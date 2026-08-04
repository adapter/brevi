import type { BreviConfig } from "./config.js";
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
 *   GET  /ws                             -> WebSocket, messages below
 *
 * Everything else serves the built dashboard (SPA fallback to index.html).
 */

export interface HealthResponse {
  ok: boolean;
  version: string;
  sandboxProvider: string;
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
