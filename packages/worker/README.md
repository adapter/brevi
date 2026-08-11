# @brevi/worker

The `brevi worker` daemon: a machine willing to execute runs. It holds today's execution stack (clone, sandbox, coding agent, PR) behind the wire protocol in `@brevi/shared`'s `worker.ts`, and dials out to a `brevi` host over a single outbound WebSocket to receive dispatched runs and mirror their progress back. The host itself never touches a sandbox; it schedules, the worker executes.

A worker only ever dials out, it never listens: `brevi worker --host <url> --token <token>` connects to a host's `/ws/worker`, registers, and from then on reports every run mutation and log line over that one socket, reconnecting with backoff if it drops. Its `sandbox.*` config (which provider, Firecracker image paths, VM size) is read from its own local `~/.brevi/config.json`, never from the host: a worker's provider and images are local to its machine.

This package is consumed by [`@brevi/cli`](https://www.npmjs.com/package/@brevi/cli); most users want `npx @brevi/cli worker` rather than this package directly.

Docs: [brevi.dev](https://brevi.dev) · Source: [github.com/adapter/brevi](https://github.com/adapter/brevi)
