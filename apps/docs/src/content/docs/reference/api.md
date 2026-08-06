---
title: API
description: The orchestrator's local HTTP and WebSocket protocol, plus the hosted OAuth endpoints on api.brevi.dev.
---

The orchestrator serves both the dashboard and its API from one process, bound to `127.0.0.1` on `server.port` (4400 by default). The protocol is defined in `packages/shared/src/protocol.ts` and shared verbatim with the dashboard.

There is no authentication: the server is loopback-only and anything reaching it already runs as you. Everything outside `/api` serves the dashboard as a single-page app.

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
| `PUT` | `/api/settings/credentials` | `CredentialsUpdateResponse` |
| `POST` | `/api/connect/:provider` | `ConnectResponse` |
| `POST` | `/api/connect/github/poll` | `DevicePollResponse` |
| `GET` | `/api/connect/linear/callback` | HTML (OAuth redirect target) |
| `GET` | `/api/github/repos` | `GithubRepo[]` |
| `PUT` | `/api/settings/repos` | `ReposUpdateResponse` |
| `PUT` | `/api/settings/sandbox` | `SandboxSettingsUpdateResponse` |
| `GET` | `/ws` | WebSocket upgrade |

Errors are `{ "error": string }` with status `400` (invalid), `404` (not found), `409` (conflict, e.g. the ticket already has an active run), or `500`.

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
  sandbox: { provider: "firecracker" | "process"; id?: string };
  createdAt: string;
  queuedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  result?: RunResult;   // prUrl / commentUrl / branch / summary / artifacts
  error?: string;
  costs: CostEntry[];
  costTotals?: CostTotals;
}
```

`GET /api/runs/:id/artifacts/:name` serves a file from the run's artifact directory with a guessed content type. Names that escape the directory are rejected with `400`.

Cancelling a terminal run is a no-op and returns it unchanged; cancelling a queued run marks it `cancelled` immediately; cancelling the active run aborts it.

`costs` has one `CostEntry` per agent execution (an attempt, or a future phase/subagent), each carrying `label`, `provider`, an optional `model`, token counts (`inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens`), an optional `costUsd` (absent when only tokens are known), and `estimated`, true when the cost is computed from a pricing table or modeled on a subscription login rather than reported by the provider. `costTotals` sums those entries for the whole run.

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
