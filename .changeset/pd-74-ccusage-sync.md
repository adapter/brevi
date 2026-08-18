---
---

Workers export a minimized, usage-only snapshot of each Claude session after every agent execution (including failures, cancellations, retries, follow-ups, and attach re-exports) over a new lease-scoped `run-usage-snapshot` frame, and Mission Control archives them atomically under `~/.brevi/ccusage/claude/projects/` so ccusage on the host can account for remote worker usage via `CLAUDE_CONFIG_DIR`. No npm package publishes; the change ships with the desktop app.
