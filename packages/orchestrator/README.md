# @brevi/orchestrator

The brevi engine. It polls Linear for `brevi`-labeled issues assigned to you, runs a coding agent against a checkout of the mapped repository inside a sandbox ([`@brevi/sandbox`](https://www.npmjs.com/package/@brevi/sandbox)), pushes a `brevi/<ticket-id>` branch, and opens a GitHub pull request; a demo (screenshots or a recording) captured by the agent stays with the run in the dashboard.

It also serves the dashboard ([`@brevi/app`](https://www.npmjs.com/package/@brevi/app)) and exposes the HTTP + WebSocket API the dashboard talks to (run streaming, connections, repository mapping).

This package is consumed by [`@brevi/cli`](https://www.npmjs.com/package/@brevi/cli); most users want `npx @brevi/cli` rather than this package directly.

Docs: [brevi.dev](https://brevi.dev) · Source: [github.com/adapter/brevi](https://github.com/adapter/brevi)
