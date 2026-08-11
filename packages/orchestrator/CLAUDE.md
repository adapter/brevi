# @brevi/orchestrator

The brevi engine, consumed by `@brevi/cli`. Polls Linear for `brevi`-labeled issues assigned to the user, dispatches each run to a connected `brevi worker`, then tracks the PR it opens. Also serves the dashboard and its HTTP + WebSocket API on :4400.

The host is a pure scheduler: it owns the run store, the ticket poll, the memory store and the fleet, but it never boots a sandbox and never execs an agent. All of that lives in `@brevi/worker`, reached over the wire protocol in `@brevi/shared`'s `worker.ts`.

## Layout (src/)

- `scheduler.ts`: run lifecycle; polls Linear, queues/retries/cancels runs, builds dispatch payloads, limit-restart logic
- `workers.ts`: the fleet registry and the enrollment gate; who is connected, which lease owns which run, how a dropped worker is given a chance to come back before its runs are given up on, and rename/drain/enable/revoke
- `fleet.ts`: worker enrollment (`FleetStore`, single-use pairing tokens, durable per-worker credentials, only their hashes on disk); state under `~/.brevi/fleet.json`
- `limits.ts`: detect "usage limit reached" in agent output, compute reset time, 1-token probe before restarting
- `linear.ts` / `github.ts`: API clients
- `server.ts`: HTTP + WS API and dashboard static serving; upgrades `/ws` (dashboard), `/ws/runs/:id/attach` (web terminal) and `/ws/worker` (the fleet)
- `terminal.ts`: relays one web-terminal socket to the interactive session on the worker that holds the run's sandbox
- `state.ts`: run persistence under `~/.brevi/` (events.jsonl per run)
- `memory.ts`: per-repo memories under `~/.brevi/memories/`, selected into each dispatch and harvested from what a run reports back
- `connect.ts` / `credentials.ts`: Connections panel flows and live credential verification
- `r2.ts`: Cloudflare R2 evidence uploads via the wrangler CLI, GIF previews via ffmpeg
- `config.ts`: load/save `~/.brevi/config.json` (schema lives in `@brevi/shared`)
- `internal.ts`: the node-side helpers `@brevi/worker` reuses (GitHub, Linear, R2, limits, memory, path safety), so the execution stack does not need a second copy of them
- `logfile.ts`: tees console output to `~/.brevi/logs/orchestrator.log` for diagnostics
- `pid.ts`: read/write `~/.brevi/server.pid`, written by whichever process runs the server and read by both the CLI and the desktop app

## Gotchas

- `pid.ts` and `config.ts` are also exposed as the `./pid` and `./config` subpath exports, for consumers (like the desktop app) that need them without pulling in the whole server and its dependencies (Linear SDK, Octokit, node-pty).
- The orchestrator reads no environment variables for persistent configuration; everything comes from `~/.brevi/config.json`. The exception is `connect.ts` credential discovery, which checks `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` (Anthropic) and `OPENAI_API_KEY` (Codex) before falling back to stored CLI logins. Credentials travel to a worker with the dispatch that needs them.
- This package must never import `@brevi/sandbox` or `@brevi/worker`; the dependency runs one way only, and CI fails the build on a sandbox import here.
- Everything a worker says is untrusted until it is bound to a lease: `workers.ts` resolves the lease first and uses `lease.runId`, never the run id on the frame, and it writes `sandbox.workerId` itself rather than accepting one. Anything new on the wire follows the same rule.
- There is no shared fleet token any more, and no `fleet.token` config field. A machine enrolls by redeeming a single-use pairing token (`POST /api/workers/pair`), which buys it a durable per-worker credential; the host stores only that credential's sha256 in `~/.brevi/fleet.json` and never writes a plaintext secret there. Revoking a worker deletes the record, so what it holds can never authenticate again.
- `/ws/worker` sockets never join the dashboard's WebSocket client set in `server.ts`: they're upgraded on the same `WebSocketServer({noServer:true})` but handed straight to `orchestrator.acceptWorkerSocket`, so they never reach the dashboard broadcast loop. A worker's first message must be a valid `register` within ~10s or the host rejects and closes; a reconnect doesn't need to wait out the old socket, the registry replaces it outright and terminates the stale one.
- The worker channel is reachable from another machine only through its own listener (`config.fleet.host`, empty and therefore off by default, started by `startFleetListener` in `server.ts`), which serves `/ws/worker` and 404s everything else. The unauthenticated management API stays on `server.host`, so enrollment never requires exposing it; `mintPairingToken` prints whichever listener is actually bound and marks the command `remote: false` when only loopback is.
- Registration is serialized against revoke on one promise chain (`WorkerRegistry#serialize`): otherwise a revoke landing mid-registration reports success and the registration then installs a connection for a worker that no longer exists.
- Memories outlive sandboxes on purpose: they are the only run state that crosses runs, so the host selects them into each dispatch and records what the run reports back.
- Protocol and config types are ground truth in `@brevi/shared`; update `apps/docs` reference pages when they change.
