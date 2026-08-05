---
"@brevi/cli": minor
---

The CLI now ships as a single self-contained package: the orchestrator, sandbox, and shared libraries are bundled into one file and the dashboard's built assets are included, so `npx @brevi/cli` installs one package with a single runtime dependency. The other @brevi packages are no longer published.
