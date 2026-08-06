---
"@brevi/cli": minor
---

`brevi update` now restarts a running instance after a successful install: it stops the old process gracefully (same SIGTERM→SIGKILL escalation as `brevi stop`), then relaunches headless from the updated bin so the new version takes effect without manual intervention. It waits up to 15s for the new server's pid file and warns (pointing at `brevi status`) instead of failing if confirmation times out. With nothing running, `update` installs without starting a new process, and the `--check` and npx/bunx runner paths are unchanged.
