---
title: API
description: The orchestrator's local HTTP and WebSocket protocol, plus the hosted OAuth endpoints on api.brevi.dev.
---

The orchestrator serves both the dashboard and its API from one process, bound to `server.host` (`127.0.0.1` by default) on `server.port` (4400 by default). The protocol is defined in `packages/shared/src/protocol.ts` and shared verbatim with the dashboard.

There is no authentication: by default the server is loopback-only and anything reaching it already runs as you. Setting `server.host` to `0.0.0.0` exposes the same unauthenticated API to the network, so anyone who can reach the port has full control; only do that on networks you trust. Everything outside `/api` serves the dashboard as a single-page app.

## Orchestrator HTTP API

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/api/health` | `HealthResponse` |
| `GET` | `/api/config` | Redacted `BreviConfig` |
| `GET` | `/api/tickets` | `Ticket[]`: the current eligible queue |
| `GET` | `/api/runs` | `Run[]`, newest first |
| `GET` | `/api/runs/:id` | `Run` |
| `GET` | `/api/runs/:id/events` | `RunEvent[]`: full history |
| `GET` | `/api/runs/:id/artifacts/:name` | Raw artifact bytes |
| `POST` | `/api/tickets/:id/run` | `Run`: manually queue a ticket |
| `POST` | `/api/runs/:id/cancel` | `Run` |
| `POST` | `/api/runs/:id/resume` | `ResumeRunResponse` |
| `POST` | `/api/runs/:id/release` | `Run` |
| `WS` | `/ws/runs/:id/attach` | Web-terminal bridge into the retained sandbox |
| `PUT` | `/api/settings/credentials` | `CredentialsUpdateResponse` |
| `POST` | `/api/connect/:provider` | `ConnectResponse` |
| `POST` | `/api/connect/github/poll` | `DevicePollResponse` |
| `GET` | `/api/connect/r2` | `R2Status` |
| `POST` | `/api/connect/r2` | `R2ConnectResponse` |
| `PUT` | `/api/settings/r2` | `R2SettingsUpdateResponse` |
| `GET` | `/api/connect/linear/callback` | HTML (OAuth redirect target) |
| `GET` | `/api/github/repos` | `GithubRepo[]` |
| `PUT` | `/api/settings/repos` | `ReposUpdateResponse` |
| `PUT` | `/api/settings/sandbox` | `SandboxSettingsUpdateResponse` |
| `GET` | `/ws` | WebSocket upgrade |

Errors are `{ "error": string }` with status `400` (invalid), `404` (not found), `409` (conflict, e.g. the ticket already has an active run), `410` (gone, e.g. a resumable sandbox's retention window passed), or `500`.

### Health

```json
{ "ok": true, "version": "0.1.0", "sandboxProvider": "process" }
```

`sandboxProvider` is the provider actually in use, after `auto` resolution.

### Runs and artifacts

```ts
type RunStatus =
  | "queued" | "preparing" | "running" | "finalizing"
  | "completed" | "failed" | "cancelled";

interface Run {
  id: string;
  ticket: Ticket;
  status: RunStatus;
  sandbox: { provider: "firecracker" | "process"; id?: string; retainedUntil?: string };
  agentSessionId?: string;  // captured from the Claude stream, powers resume
  createdAt: string;
  queuedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  result?: RunResult;   // prUrl / branch / summary / artifacts
  error?: string;
  costs: CostEntry[];
  costTotals?: CostTotals;
}
```

`GET /api/runs/:id/artifacts/:name` serves a file from the run's artifact directory with a guessed content type. Names that escape the directory are rejected with `400`.

Cancelling a terminal run is a no-op and returns it unchanged; cancelling a queued run marks it `cancelled` immediately; cancelling the active run aborts it.

`costs` has one `CostEntry` per agent execution (an attempt, or a future phase/subagent), each carrying `label`, `provider`, an optional `model`, token counts (`inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens`), an optional `costUsd` (absent when only tokens are known), and `estimated`, true when the cost is computed from a pricing table or modeled on a subscription login rather than reported by the provider. An entry may also carry an optional `breakdown`: an array of per-model `CostModelUsage` rows, each with `model`, its own token counts (`inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens`), and an optional `costUsd`; the entry's own token and cost figures are the roll-up (sum) of its breakdown rows. `breakdown` is present only when measured from the agent's transcripts by ccusage inside the sandbox; it's absent for stream-parsed entries (Codex, sandboxes without ccusage), which stay single-model. `costTotals` sums those entries for the whole run.

### Resume and release

A completed or failed run keeps its sandbox disk around for `sandbox.retentionHours` (see [Configuration](/reference/configuration/)): the checkout with the run's changes, installed dependencies, and credentials, ready to pick the conversation back up.

`POST /api/runs/:id/resume` boots that sandbox back up (if it isn't already) and prepares an interactive `claude --resume <sessionId>` session inside it:

```ts
interface ResumeRunResponse {
  run: Run;
  attach: RunAttachInfo;
}

type RunAttachInfo =
  | { kind: "local"; scriptPath: string }
  | { kind: "ssh"; scriptPath: string; host: string; user: string; keyPath: string };
```

`attach` tells the caller how to open the session: `"local"` runs `scriptPath` directly on the host (process sandboxes), `"ssh"` runs it in the guest over ssh with the given `host` / `user` / `keyPath` (Firecracker sandboxes). `brevi attach <runId>` calls this endpoint and opens whichever it gets back.

Errors: `404` when the run doesn't exist, `409` when the run hasn't finished yet or the configured sandbox provider has changed since it did, `410` once the retention window has passed and the disk was reclaimed, `400` when the run has no captured agent session id (resume is Claude-only for now; Codex runs don't report one).

`POST /api/runs/:id/release` stops a resumed sandbox's compute again, keeping its disk until the retention window ends, and returns the updated `Run`. `brevi attach` calls it on detach; it's a no-op when nothing is booted.

### Web terminal

`WS /ws/runs/:id/attach` is what the run detail page's "Open terminal" button connects to: the server performs the whole resume flow itself (boot, session script, release on disconnect) and bridges the session to the socket through a PTY, so the browser needs no ssh access and the orchestrator can live on a different machine. Messages are JSON in both directions:

```ts
// server -> client
type AttachServerMessage =
  | { type: "data"; data: string }      // terminal output
  | { type: "exit"; code: number }      // the session process ended
  | { type: "error"; message: string }; // resume failed (same reasons as POST /resume)

// client -> server
type AttachClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };
```

Multiple clients (web terminals, `brevi attach` sessions) share one booted sandbox; it stops again when the last one disconnects.

### Credentials

```http
PUT /api/settings/credentials
Content-Type: application/json

{ "linearApiKey": "lin_api_…", "githubToken": "", "anthropicApiKey": "sk-ant-…" }
```

Only the fields you send are touched. Each is validated against its provider before being saved; invalid keys are rejected per field while valid ones in the same request are still applied. An empty string disconnects that provider without validation.

```json
{
  "results": {
    "linear": { "ok": true, "detail": "Connected as Jane" },
    "anthropic": { "ok": false, "detail": "Anthropic rejected this credential" }
  },
  "config": { "linear": { "apiKey": "***" } }
}
```

### Connect

`POST /api/connect/:provider` with `provider` one of `linear`, `github`, `anthropic`, `codex` runs the one-click strategy chain and reports what the dashboard should do next. It returns one of four shapes:

```ts
| { status: "connected"; provider; detail: string; config: BreviConfig }
| { status: "device"; provider: "github"; userCode: string;
    verificationUri: string; interval: number; expiresIn: number }
| { status: "redirect"; provider: "linear"; url: string }
| { status: "manual"; provider; reason: string }
```

- `"device"` → show `userCode`, open `verificationUri`, then poll `POST /api/connect/github/poll` every `interval` seconds. That returns `{ status: "pending" }`, `{ status: "connected", detail, config }`, or `{ status: "error", detail }`.
- `"redirect"` → open `url`. Linear sends the browser back to `GET /api/connect/linear/callback?code=…&state=…`, which exchanges the code, saves the token, broadcasts the new config over the WebSocket, and renders a small "you can close this window" page.
- `"manual"` → show the key input; `reason` explains what brevi looked for and didn't find.

### Repositories

`GET /api/github/repos` lists repos visible to the connected token, most recently pushed first, as `{ fullName, defaultBranch, private, description, pushedAt }`. It returns `400` when GitHub isn't connected.

`PUT /api/settings/repos` replaces `repos` and `defaultRepo` **wholesale**:

```json
{
  "repos": { "brevi": { "remote": "adapter/brevi", "defaultBranch": "main" } },
  "defaultRepo": "brevi"
}
```

Each entry is validated against the repo schema; a bad remote or an unknown `defaultRepo` returns `400` and nothing is written. On success, tickets are re-resolved against the new mappings straight away.

### Sandbox settings

`PUT /api/settings/sandbox` updates `sandbox.concurrency`, how many sandboxed runs execute at once:

```json
{ "concurrency": 2 }
```

The value is persisted to `~/.brevi/config.json` and takes effect immediately, no restart needed: raising the limit starts queued runs right away, and lowering it lets already-running sandboxes finish out rather than cancelling them. Values outside `1` to `16`, or non-integers, are rejected with `400` and nothing is written.

### R2 connector

There is no stored credential for R2: `GET /api/connect/r2` probes the host's `wrangler` CLI live on every call.

```ts
interface R2Status {
  installed: boolean;       // wrangler CLI is on the host
  loggedIn: boolean;        // `wrangler whoami` reports an identity
  account?: string;         // account email, when logged in
  bucket: string;           // config.r2.bucket, "" if unset
  publicBaseUrl: string;    // config.r2.publicBaseUrl, "" if unset
  ready: boolean;           // installed && loggedIn && bucket && publicBaseUrl
}
```

`POST /api/connect/r2` starts the one-click flow:

```ts
| { status: "connected"; r2: R2Status }
| { status: "login-started"; detail: string }
| { status: "unavailable"; reason: string }
```

`"connected"` means `wrangler whoami` was already authenticated, nothing to do. `"login-started"` means brevi spawned `wrangler login` on the host, which opens a browser for interactive OAuth; the dashboard should poll `GET /api/connect/r2` until `loggedIn` flips. `"unavailable"` means wrangler isn't installed; `reason` says so.

`PUT /api/settings/r2` sets the bucket and its public base URL:

```json
{ "bucket": "my-evidence-bucket", "publicBaseUrl": "https://pub-xxxx.r2.dev" }
```

```ts
interface R2SettingsUpdateResponse {
  config: BreviConfig;  // redacted
  r2: R2Status;          // live state after the update
}
```

Only provided fields are touched; each is trimmed, and a trailing slash is stripped from `publicBaseUrl`. A non-empty `publicBaseUrl` must parse as an `http(s)` URL, or the request is rejected with `400` and nothing is written.

## WebSocket

Connect to `ws://localhost:4400/ws`. The server sends a `hello` immediately, then pushes changes:

```ts
type ServerMessage =
  | { type: "hello"; runs: Run[]; tickets: Ticket[]; config: BreviConfig }
  | { type: "config"; config: BreviConfig }
  | { type: "tickets"; tickets: Ticket[] }
  | { type: "run-updated"; run: Run }
  | { type: "run-event"; event: RunEvent };

type ClientMessage =
  | { type: "subscribe"; runId: string }
  | { type: "unsubscribe"; runId: string };
```

Every `config` payload is redacted. By default a client receives `run-event` messages for **all** runs; once it subscribes to at least one run id it receives events only for its subscriptions.

`RunEvent` is one of a status change, a log line (`stdout` / `stderr` / `system`), an `agent` event forwarded from the agent's `stream-json` output, an artifact reference, or a `cost` entry recording one agent execution's LLM usage. Events are also persisted as JSONL, which is what `GET /api/runs/:id/events` replays.

## api.brevi.dev

`https://api.brevi.dev` hosts brevi's OAuth applications so one-click Connect works without registering anything. It is a Hono app on Cloudflare Workers (`apps/api` in the repo) and holds only the OAuth client id/secret; tokens are returned to your machine and stored in `~/.brevi/config.json`.

The local orchestrator calls it automatically when `connect.githubClientId` / `connect.linearClientId` are unset. `connect.apiBase` overrides the base URL.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness check |
| `POST` | `/oauth/github/device/code` | Start a GitHub device authorization with brevi's client id |
| `POST` | `/oauth/github/device/token` | Poll that authorization for an access token |
| `GET` | `/oauth/linear/authorize?state=&port=` | `302` to Linear's authorize URL with brevi's client id |
| `POST` | `/oauth/linear/token` | Exchange `{ code, port }` for an access token, using the secret held server-side |

`/oauth/linear/authorize` builds the redirect back to `http://localhost:<port>/api/connect/linear/callback`, so the token exchange lands on your machine; `port` is your `server.port`. The `state` you pass through is the one the local orchestrator checks on the callback.

Deploying your own copy needs three secrets (`GITHUB_CLIENT_ID`, `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`) and a Linear app registering `http://localhost:<port>/api/connect/linear/callback` redirect URIs for the ports you use.
