---
"@brevi/shared": minor
"@brevi/orchestrator": minor
"@brevi/app": minor
"@brevi/cli": minor
---

Add a `sandbox.concurrency` config field (default 1) that caps how many sandboxed runs execute at once; the scheduler runs a pool of runs up to that limit. Adjustable live from Mission Control via `PUT /api/settings/sandbox`, no restart needed.
