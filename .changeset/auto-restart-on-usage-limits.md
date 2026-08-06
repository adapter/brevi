---
"@brevi/cli": minor
---

Runs interrupted by a Claude Code or Codex usage limit now restart automatically. The orchestrator detects the limit from the agent's output (including the reset time when the agent reports one: five-hour window, weekly limit, or an explicit epoch/duration), parks the run in a new `waiting` status, and starts a fresh attempt once the limit lifts, confirming with a 1-token probe against the same credentials before restarting; when no reset time is known it re-probes on an interval (`restart.probeIntervalMinutes`, default 15m). Each execution is recorded as an attempt on the run, with markers in the event log so every attempt's output is preserved, capped by `restart.maxAttempts` (default 5, auto-restart toggled by `restart.auto`). Waiting runs survive orchestrator restarts. A new `POST /api/runs/:id/retry` endpoint plus dashboard Retry/Resume-now buttons let you restart failed or cancelled runs and skip the wait on waiting ones by hand.
