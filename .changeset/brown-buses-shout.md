---
"@brevi/cli": minor
---

`npx @brevi/cli` is now the single entry point: running it with no arguments starts the orchestrator and opens the dashboard, and on first launch (no `~/.brevi/config.json`) it runs the init flow automatically first — a fresh machine goes from zero to dashboard in one command. In non-interactive terminals a missing config fails with a clear message instead of hanging on a prompt. The `ui` subcommand is deprecated and hidden (it now behaves like the bare invocation); `init`, `start`, and `status` are unchanged.
