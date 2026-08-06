# @brevi/orchestrator

The brevi engine, consumed by `@brevi/cli`. Polls Linear for `brevi`-labeled issues assigned to the user, classifies each as SPIKE (research) or implementation, runs a coding agent in a sandbox against a checkout of the mapped repo, then opens a PR (implementation) or posts a Linear comment (SPIKE). Also serves the dashboard and its HTTP + WebSocket API on :4400.

## Layout (src/)

- `scheduler.ts`: run lifecycle; polls Linear, queues/retries/cancels runs, limit-restart logic
- `runner.ts`: one run end to end; clone, build the agent invocation (`claude -p ... --output-format stream-json`), exec in sandbox, push branch, open PR, comment
- `prompts.ts`: the prompt templates given to agents (summary, demo evidence, PR requirements)
- `limits.ts`: detect "usage limit reached" in agent output, compute reset time, 1-token probe before restarting
- `linear.ts` / `github.ts`: API clients
- `server.ts`: HTTP + WS API and dashboard static serving
- `state.ts`: run persistence under `~/.brevi/` (events.jsonl per run)
- `connect.ts` / `credentials.ts`: Connections panel flows and live credential verification
- `r2.ts`: Cloudflare R2 evidence uploads via the wrangler CLI, GIF previews via ffmpeg
- `config.ts`: load/save `~/.brevi/config.json` (schema lives in `@brevi/shared`)

## Gotchas

- The orchestrator reads no environment variables for persistent configuration; everything comes from `~/.brevi/config.json`. The exception is `connect.ts` credential discovery, which checks `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` (Anthropic) and `OPENAI_API_KEY` (Codex) before falling back to stored CLI logins. Agent credentials are passed into the sandbox env explicitly.
- Agent output is parsed as stream-json events; limit detection only inspects error-typed events to avoid false positives.
- Protocol and config types are ground truth in `@brevi/shared`; update `apps/docs` reference pages when they change.
