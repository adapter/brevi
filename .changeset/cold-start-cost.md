---
"@brevi/shared": minor
"@brevi/orchestrator": minor
"@brevi/sandbox": minor
---

Cut per-run cold-start cost: Claude implementation runs now put the main agent loop on `agent.orchestratorModel` (default Fable 5) which delegates the coding work to an `implementer` subagent on `agent.implementModel` (default Sonnet 5), every prompt carries a generated repo map (file list plus recent commits), Playwright's Chromium is provisioned once per host instead of per run (baked into the Firecracker rootfs at /opt/ms-playwright, a shared `~/.brevi/cache` for the process provider), and demo evidence is proportional via `repos.<key>.demo` (`always` / `auto` / `never`).
