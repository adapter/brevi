# @brevi/orchestrator

The brevi engine, consumed by `@brevi/cli`. Polls Linear for `brevi`-labeled issues assigned to the user, dispatches each run to a connected `brevi worker`, then tracks the PR it opens. Also serves the dashboard and its HTTP + WebSocket API on :4400.

The host is a pure scheduler: it owns the run store, the ticket poll, the memory store and the fleet, but it never boots a sandbox and never execs an agent. All of that lives in `@brevi/worker`, reached over the wire protocol in `@brevi/shared`'s `worker.ts`.

## Layout (src/)

- `scheduler.ts`: run lifecycle; polls Linear, queues/retries/cancels runs, builds dispatch payloads, limit-restart logic
- `workers.ts`: the fleet registry; who is connected, which lease owns which run, and how a dropped worker is given a chance to come back before its runs are given up on
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

## Gotchas

- The orchestrator reads no environment variables for persistent configuration; everything comes from `~/.brevi/config.json`. The exception is `connect.ts` credential discovery, which checks `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` (Anthropic) and `OPENAI_API_KEY` (Codex) before falling back to stored CLI logins. Credentials travel to a worker with the dispatch that needs them.
- This package must never import `@brevi/sandbox` or `@brevi/worker`; the dependency runs one way only, and CI fails the build on a sandbox import here.
- Everything a worker says is untrusted until it is bound to a lease: `workers.ts` resolves the lease first and uses `lease.runId`, never the run id on the frame, and it writes `sandbox.workerId` itself rather than accepting one. Anything new on the wire follows the same rule.
- `fleet.token` is a credential, not a setting: it is masked in every read (`redactConfig`) and readable in the clear only from loopback, via `GET /api/fleet/pairing`.
- Memories outlive sandboxes on purpose: they are the only run state that crosses runs, so the host selects them into each dispatch and records what the run reports back.
- Protocol and config types are ground truth in `@brevi/shared`; update `apps/docs` reference pages when they change.
