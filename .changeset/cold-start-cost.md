---
"@brevi/shared": minor
"@brevi/orchestrator": minor
"@brevi/sandbox": minor
---

Cut per-run cold-start cost: Claude implementation runs are now two-phase (a planning agent on `agent.planModel`, default Fable 5, writes a plan that an implementation agent on `agent.implementModel`, default Sonnet 5, executes), every prompt carries a generated repo map (file list plus recent commits), Playwright's Chromium is provisioned once per host instead of per run (baked into the Firecracker rootfs at /opt/ms-playwright, a shared `~/.brevi/cache` for the process provider), and demo evidence is proportional via `repos.<key>.demo` (`always` / `auto` / `never`).
