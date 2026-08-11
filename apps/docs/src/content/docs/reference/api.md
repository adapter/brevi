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
| `POST` | `/api/runs/:id/retry` | `Run` |
| `POST` | `/api/runs/:id/followup` | `Run`: start a follow-up on a completed run's open PR |
| `GET` | `/api/runs/:id/pr` | `PrStatusResponse` |
| `POST` | `/api/runs/:id/resume` | `ResumeRunResponse` |
| `POST` | `/api/runs/:id/release` | `Run` |
| `WS` | `/ws/runs/:id/attach` | Web-terminal bridge into the retained sandbox |
| `WS` | `/ws/worker` | The worker channel: where `brevi worker` daemons enroll, register, and receive dispatches |
| `GET` | `/api/workers` | `FleetResponse`: every enrolled worker |
| `POST` | `/api/workers/pair` | `PairingTokenResponse` |
| `POST` | `/api/workers/:id/rename` | `FleetResponse` |
| `POST` | `/api/workers/:id/drain` | `FleetResponse` |
| `POST` | `/api/workers/:id/enable` | `FleetResponse` |
| `DELETE` | `/api/workers/:id` | `FleetResponse`: revoke the worker's enrollment |
| `PUT` | `/api/settings/credentials` | `CredentialsUpdateResponse` |
| `POST` | `/api/connect/:provider` | `ConnectResponse` |
| `POST` | `/api/connect/github/poll` | `DevicePollResponse` |
| `GET` | `/api/connect/r2` | `R2Status` |
| `POST` | `/api/connect/r2` | `R2ConnectResponse` |
| `GET` | `/api/connect/linear/callback` | HTML (OAuth redirect target) |
| `GET` | `/api/github/repos` | `GithubRepo[]` |
| `GET` | `/api/linear/projects` | `LinearProject[]` |
| `PUT` | `/api/settings` | `SettingsUpdateResponse` |
| `GET` | `/ws` | WebSocket upgrade |

Errors are `{ "error": string }` with status `400` (invalid), `404` (not found), `409` (conflict, e.g. the ticket already has an active run), `410` (gone, e.g. a resumable sandbox's retention window passed), or `500`.

### Health

```json
{ "ok": true, "version": "0.1.0", "sandboxProvider": "process", "hostMemMib": 16384 }
```

`sandboxProvider` is the provider actually in use, after `auto` resolution. `hostMemMib` is total host memory in MiB, used by the dashboard's capacity hint (memory per VM times `sandbox.concurrency`, with a warning when it exceeds host memory).

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
  prUrl?: string;       // the ticket's PR, kept at run level so it survives retries
  prState?: "open" | "draft" | "merged" | "closed";
}
```

`GET /api/runs/:id/artifacts/:name` serves a file from the run's artifact directory with a guessed content type. Names that escape the directory are rejected with `400`.

Cancelling a terminal run is a no-op and returns it unchanged; cancelling a queued run marks it `cancelled` immediately; cancelling the active run aborts it.

`prUrl` and `prState` are set once a run opens a PR and track it at run level, so a retry (which clears `result`) never loses sight of the PR. `prState` is the last observed GitHub state: refreshed by a lazy background poll (about every 2 minutes, for the most recent runs whose PR hasn't merged or closed, whatever the run's own status) and whenever a run's detail view is opened, and streamed to the dashboard over the WebSocket as a `run-updated` message. The sidebar's PR chip and inline actions render from it.

`costs` has one `CostEntry` per agent execution (an attempt, or a future phase/subagent), each carrying `label`, `provider`, an optional `model`, token counts (`inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens`), an optional `costUsd` (absent when only tokens are known), and `estimated`, true when the cost is computed from a pricing table or modeled on a subscription login rather than reported by the provider. An entry may also carry an optional `breakdown`: an array of per-model `CostModelUsage` rows, each with `model`, its own token counts (`inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens`), and an optional `costUsd`; the entry's own token and cost figures are the roll-up (sum) of its breakdown rows. `breakdown` is present when the execution spanned several models (e.g. a delegated Claude run with an implementer subagent), whether measured from the agent's transcripts by ccusage inside the sandbox or reconstructed from the output stream; single-model executions stay flat. `costTotals` sums those entries for the whole run, and beyond the run-wide sums it also carries `byModel`: an array of `CostModelTotal` rows, one per distinct model used anywhere in the run, each with summed token counts (`inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens`), an optional `costUsd`, and an `estimated` flag; a model used by several attempts or phases appears once with summed figures, and the dashboard displays this per-model roll-up rather than the per-execution entries.

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

### Follow-ups

`POST /api/runs/:id/followup` starts a follow-up on a completed run's open PR: it rebases the PR branch onto the latest base inside a sandbox (reusing the run's retained sandbox when still within the retention window, otherwise a fresh checkout), lets the agent resolve conflicts and address unresolved review threads, review summaries, and new comments, pushes with `--force-with-lease`, and posts one summary comment on the PR; the run's console streams the whole session and costs append as `follow-up` entries. The checkout and push target come from the PR itself (its own repository and live head branch), every push gets a summary comment (a drift-only rebase included), and the Linear ticket state is untouched; follow-ups run even while Linear is disconnected.

Errors: `404` unknown run, `409` when the run is not completed, another execution is active, or the PR is merged/closed, `400` when the run has no PR or GitHub is not connected.

`GET /api/runs/:id/pr` returns `{ url, number, state }` with state `open | draft | merged | closed`, used by the dashboard to hide the follow-up button once the PR is merged or closed.

### Web terminal

`WS /ws/runs/:id/attach` is what the run detail page's "Open terminal" button connects to. A finished run's retained sandbox lives on the worker that executed it, never on the scheduling host, so the host relays: it asks that worker to open the resume session and passes its PTY bytes through to this socket. The browser needs no ssh access, and `brevi attach` uses the same socket for the same reason. Messages are JSON in both directions:

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

### Workers

Runs execute on `brevi worker` daemons, not on the host: the orchestrator is a pure scheduler and never boots a sandbox itself. A machine becomes one of this host's workers by redeeming a single-use pairing token, which buys it a durable per-worker credential; these endpoints are that fleet's management surface, and the dashboard's Workers page (Configuration > Workers, `/config/workers`) is built on them.

`GET /api/workers` returns every enrolled worker, connected or not, oldest enrollment first:

```ts
interface FleetResponse {
  workers: WorkerView[];
}

interface WorkerView {
  id: string;               // assigned by the host at enrollment, e.g. "wk-3f9a1c22b0"
  name: string;
  state: "active" | "draining";
  connection: "online" | "offline";
  capabilities?: WorkerCapabilities;  // absent for a worker that has never connected
  activeRuns: number;    // leases this worker holds right now
  enrolledAt: string;
  connectedAt?: string;  // when the current connection was established, absent while offline
  lastSeenAt?: string;   // last register or heartbeat, absent until the first connect
  address?: string;      // remote address of the live channel, when connected
}

interface WorkerCapabilities {
  os: string;            // process.platform, e.g. "linux" or "darwin"
  arch: string;          // process.arch, e.g. "x64" or "arm64"
  provider: "firecracker" | "process";
  kvm: boolean;          // /dev/kvm present and usable
  maxConcurrency: number;  // dispatched runs this worker executes at once, 1 to 64
  vmSizes: ("small" | "medium" | "large")[];  // empty for a process worker
  version: string;       // brevi version running on the worker
}
```

No credential material ever appears here: the host stores only the sha256 of each worker's credential (in `~/.brevi/fleet.json`, mode `0600`), and even that never leaves the process.

`POST /api/workers/pair` mints a single-use pairing token and the ready-to-copy command that redeems it, good for `PAIRING_TOKEN_TTL_MINUTES` (15) minutes unless redeemed first:

```json
{
  "token": "bwp_…",
  "expiresAt": "2026-08-11T15:15:00.000Z",
  "command": "brevi worker --host http://192.168.1.5:4410 --token bwp_…",
  "host": "http://192.168.1.5:4410",
  "remote": true
}
```

`token` is returned exactly once, by this call; the host keeps only what it needs to redeem it, so a token not copied out of this response is unrecoverable. Nothing shows up in `GET /api/workers` until a machine runs the command and registers over `/ws/worker` (below). The address in `command` is the listener a worker should dial: the dedicated fleet listener when `fleet.host` is set, otherwise the dashboard's own.

`remote` says whether `host` is genuinely reachable from another machine: a wildcard bind (`fleet.host` or `server.host` set to `"0.0.0.0"`) resolves to a guessed LAN address and reports `true`; a loopback-only bind prints `"http://localhost:<port>"` and reports `false` rather than inventing a LAN address nothing answers on. The dashboard uses it to warn when the printed command will only ever work on this machine.

`POST /api/workers/:id/rename` with `{ "name": "..." }` (trimmed, control characters stripped, capped at 60 characters; empty is `400`), `POST /api/workers/:id/drain` (finish in-flight runs, accept nothing new; the state is persisted and survives reconnects), `POST /api/workers/:id/enable` (put a drained worker back in rotation), and `DELETE /api/workers/:id` (revoke: the credential dies and the worker is disconnected at once, unable to reconnect with what it holds) all return the updated `FleetResponse`, or `404` for an id that is not enrolled.

### Worker channel

`WS /ws/worker` is the channel `brevi worker` (see [CLI](/reference/cli/#brevi-worker)) connects to. Each worker dials it outbound and never accepts inbound connections, so a worker behind NAT needs no port open. The wire protocol is defined as zod schemas in `packages/shared/src/worker.ts` and is versioned (`WORKER_PROTOCOL_VERSION`, currently `2`); a worker on a different version is rejected on registration.

It is served in two places: always by the dashboard's own listener (`server.host` / `server.port`), so a worker on this same machine can always enroll, and additionally by a dedicated listener bound to `fleet.host` / `fleet.port` (see [Configuration](/reference/configuration/#fleet)) when `fleet.host` is set. That second listener exists so a worker on another machine can reach `/ws/worker` without exposing the unauthenticated management API above, which stays on `server.host` regardless; the dedicated listener serves nothing else, and every other request on it gets a `404`.

The first frame on every connection is `register`, which carries the protocol version, the worker's capabilities, the leases it still believes it owns, and an auth envelope:

```ts
// worker -> host
type RegisterMessage = {
  type: "register";
  protocolVersion: number;
  auth:
    | { kind: "pairing"; token: string }                        // enrolling
    | { kind: "credential"; workerId: string; secret: string };  // every connect after
  name: string;                 // preferred display name, honoured only when enrolling
  capabilities: WorkerCapabilities;
  activeLeases: RunLease[];     // so in-flight run reporting resumes after a drop
};

// host -> worker
type RegisteredMessage = {
  type: "registered";
  protocolVersion: number;
  heartbeatIntervalMs: number;
  hostVersion: string;
  workerId: string;             // the host assigns it; a worker never picks its own
  name: string;                 // the fleet's name for this worker, which a rename may have changed
  state: "active" | "draining";
  credential?: string;          // only on the connection that redeemed a pairing token
};

type RejectedMessage = {
  type: "rejected";
  code: "invalid-token" | "expired-token" | "unauthorized" | "protocol" | "malformed";
  reason: string;
};
```

A `pairing` envelope redeems the token once and enrolls the machine; the `registered` answer carries the assigned `workerId` and the durable `credential`, which the worker stores at `~/.brevi/worker.json` (mode `0600`, the only fleet secret on its disk) and presents as `{ kind: "credential" }` on every later connect. A pairing token is single-use and dies on redemption or at its expiry, and the host keeps only its hash in memory, never on disk. `rejected` is answered with a `code` so the worker can branch without parsing prose: `invalid-token` / `expired-token` let a worker that also holds a credential retry with it, `unauthorized` means the enrollment is gone for good and the worker deletes its stored credential, and `protocol` / `malformed` are build or frame problems retrying cannot fix. The host closes the socket right after sending it. A connection whose first frame is not a valid `register` within 10 seconds is rejected and dropped the same way.

After registration the worker sends `heartbeat` every 15 seconds (`WORKER_HEARTBEAT_MS`) with the leases it still claims, and the host answers `heartbeat-ack` carrying the worker's current state, so a drain reaches a worker even if it missed the push. Silence longer than `fleet.heartbeatTimeoutSeconds` (45 by default) drops the connection; a worker that drops mid-run has `fleet.reconnectGraceSeconds` (120 by default) to come back and resume reporting before its runs are failed.

Runs travel the same channel: `dispatch` for each run the host hands over (answered with `dispatch-accepted` or `dispatch-rejected`), a stream of `run-patch` / `run-event` / `run-artifact` / `run-memories` frames as the run executes, and finally `run-complete` carrying the whole terminal state, which the host answers with `run-complete-ack`. The worker keeps claiming a lease until that acknowledgement arrives, so a run that finished while the socket was down replays its completion on the next connection instead of being recorded as a disconnect failure. `cancel` and `discard` travel the other way, as do `attach-open` and the rest of the interactive-session relay behind the web terminal. A dispatch carries the credentials that one run needs (GitHub, agent, Linear) inline over this authenticated connection, provisioned into that run's sandbox and gone with it, so a worker is never configured with a connector secret of its own. Enrollment copies none either, which is what makes revoking a worker enough to cut off its access.

Two more host-to-worker frames belong to the fleet rather than to a run: `worker-state` is pushed the moment an operator drains or re-enables a worker, so a drain takes effect at once rather than at the next heartbeat, and `revoked` tells a worker its enrollment is gone, on which it deletes its stored credential, shuts its runs down gracefully, and exits instead of reconnecting into a rejection loop.

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

Repo mappings themselves are edited through `PUT /api/settings` (below), like every other config field.

### Memories

`GET /api/memories` returns everything brevi remembers, keyed by repository remote (`owner/name`), newest first. Repositories with nothing stored are omitted.

```ts
interface MemoriesResponse {
  repos: Record<string, RepoMemory[]>;
}

interface RepoMemory {
  id: string;
  text: string;        // the fact, one line
  createdAt: string;
  updatedAt: string;   // last time a run recorded it again
  hits: number;        // how many runs have recorded it
  ident?: string;      // ticket that last recorded it
}
```

`POST /api/memories/:repo/forget` with `{ "id": "..." }` drops one memory; `POST /api/memories/:repo/clear` drops all of a repository's. `:repo` is the URL-encoded remote. Both return the updated `MemoriesResponse`, `404` when there is nothing to drop, and `500` when the deletion could not be written to disk. Memories are written by runs, never by the API.

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

The bucket and its public base URL are config fields like any other; set them with `PUT /api/settings`.

## Settings

`PUT /api/settings` is the only write path for `~/.brevi/config.json`. The body carries a deep-partial patch of the fields one form card owns, so a save never touches anything the caller did not send, including fields another tab or a hand edit changed in the meantime:

```json
{
  "patch": {
    "agent": { "orchestratorModel": "claude-opus-5", "orchestratorEffort": "medium" },
    "sandbox": { "firecracker": { "size": "large", "vcpus": null, "memMib": null } }
  }
}
```

Objects merge key by key; arrays and scalars replace. `null` **removes** a key, which is how an optional field is cleared (`{"defaultRepo": null}`) and how a repo mapping is deleted (`{"repos": {"web": null}}`).

```ts
interface SettingsUpdateResponse {
  config: BreviConfig;            // redacted, for re-rendering every form
  applied: "live" | "restart";
}
```

The patch is merged onto the config on disk, the **whole** result is validated against the config schema, and only then is the file replaced (written to a temp file and renamed, so a reader never sees a half-written config). A rejection returns `400` with the zod message, prefixed by the field path, and nothing is written:

```json
{ "error": "agent.orchestratorEffort: Invalid option: expected one of \"low\"|\"medium\"|\"high\"" }
```

Two rules span fields and are checked after the schema: `defaultRepo` has to name a configured repo key, and a non-empty `r2.publicBaseUrl` has to parse as an `http(s)` URL.

Credential fields are refused here with `400`: `linear.apiKey`, `linear.refreshToken`, `linear.tokenExpiresAt`, `github.token`, and the four `agent.*` keys. Most of them are masked in every read, so accepting them would let a form round-trip the mask over a live secret; `linear.tokenExpiresAt` is not itself masked and is refused because the OAuth flow maintains it. They are written by the Connect flows and `PUT /api/settings/credentials`, which verify each key with its provider. `connect.linearClientSecret` is write-only rather than refused: it can be set, but the literal mask value is rejected. The `fleet` section holds no secret at all: worker credentials are minted, not configured, and only their hashes are stored (see [Workers](#workers)).

The check compares credential values on the merged result, not paths in the patch, so deleting a whole section (`{"linear": null}`, which would let the schema defaults refill it with empty strings) is refused the same way as setting the field directly.

`applied` says whether the change is already in effect. Almost everything is read per run or per poll and applies live; `server.port`, `server.host`, and `sandbox.provider` are bound once at startup and answer `"restart"`.

`config.json` stays the source of truth in both directions: the orchestrator watches the file and picks up hand edits without a restart, broadcasting the reloaded config over the WebSocket. An external edit that does not validate is logged and ignored, leaving the running settings alone.

## WebSocket

Connect to `ws://localhost:4400/ws`. The server sends a `hello` immediately, then pushes changes:

```ts
type ServerMessage =
  | {
      type: "hello";
      runs: Run[];
      tickets: Ticket[];
      config: BreviConfig;
      linearStatus: LinearStatus;
      workers: WorkerView[];
    }
  | { type: "config"; config: BreviConfig }
  | { type: "tickets"; tickets: Ticket[] }
  | { type: "workers"; workers: WorkerView[] }
  | { type: "run-updated"; run: Run }
  | { type: "run-event"; event: RunEvent }
  | { type: "linear-status"; linearStatus: LinearStatus };

type LinearStatus = {
  state: "disconnected" | "connected" | "auth-error" | "refresh-failing";
  error?: string;
};

type ClientMessage =
  | { type: "subscribe"; runId: string }
  | { type: "unsubscribe"; runId: string };
```

Every `config` payload is redacted. By default a client receives `run-event` messages for **all** runs; once it subscribes to at least one run id it receives events only for its subscriptions. `linear-status` is pushed whenever the Linear connector's state changes, e.g. an OAuth token refresh failing, so the dashboard can show a Reconnect prompt without polling for it. `auth-error` means the stored credential is dead and polling is paused until a reconnect; `refresh-failing` means the expired token can't be refreshed for a transient reason (network, rate limit), polling is paused, and brevi retries by itself until a refresh succeeds. `workers` (in `hello`, and pushed again on its own as a `workers` message) is the same `WorkerView[]` `GET /api/workers` returns, so the Workers page never has to poll: an enrollment, a renamed or drained worker, a heartbeat's fresh capabilities, a connect or a drop, and a revocation all arrive this way.

`RunEvent` is one of a status change, a log line (`stdout` / `stderr` / `system`), an `agent` event forwarded from the agent's `stream-json` output, an artifact reference, a `cost` entry recording one agent execution's LLM usage, or a `limit` event recording the agent usage limit that ended an execution. Events are also persisted as JSONL, which is what `GET /api/runs/:id/events` replays.

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
| `POST` | `/oauth/linear/refresh` | Exchange `{ refresh_token }` for a fresh access token, using the secret held server-side |

`/oauth/linear/authorize` builds the redirect back to `http://localhost:<port>/api/connect/linear/callback`, so the token exchange lands on your machine; `port` is your `server.port`. The `state` you pass through is the one the local orchestrator checks on the callback.

Both `/oauth/linear/token` and `/oauth/linear/refresh` return `{ access_token, refresh_token?, expires_in? }`, forwarded from Linear's own response, so the orchestrator can store the refresh token and proactively refresh the access token before it expires. `/oauth/linear/refresh` returns `401` only when Linear rejects the grant itself (a revoked or invalid refresh token), passes a `429` rate limit through along with its `Retry-After` header, and returns `502` on other upstream failures, so clients can tell "reconnect required" apart from "try again later".

Deploying your own copy needs three secrets (`GITHUB_CLIENT_ID`, `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`) and a Linear app registering `http://localhost:<port>/api/connect/linear/callback` redirect URIs for the ports you use.
