# @brevi/worker

The `brevi worker` daemon: a machine willing to execute runs. It holds today's execution stack (clone, sandbox, coding agent, PR) behind the wire protocol in `@brevi/shared`'s `worker.ts`, and dials out to a `brevi` host over a single outbound WebSocket to receive dispatched runs and mirror their progress back. The host itself never touches a sandbox; it schedules, the worker executes.

A worker only ever dials out, it never listens: `brevi worker --host <url> --token <token>` connects to a host's `/ws/worker`, registers, and from then on reports every run mutation and log line over that one socket, reconnecting with backoff if it drops. Its `sandbox.*` config (concurrency, timeout, retention) is read from its own local `~/.brevi/config.json`, never from the host.

This package is consumed by [`@brevi/cli`](https://www.npmjs.com/package/@brevi/cli); most users want `npx @brevi/cli worker` rather than this package directly.

## Install on a Linux server

The hosted installer (`scripts/install.sh`, published at `https://brevi.dev/install.sh`) turns a stock Ubuntu/Debian server into a connected worker: it provisions a dedicated `brevi` system user, installs the `brevi` binary and bubblewrap, and runs the daemon as `brevi-worker.service`. It is idempotent: re-run the same command, or `sudo brevi worker update`, to upgrade in place without losing enrollment or settings.

```sh
curl -fsSL https://brevi.dev/install.sh | sudo sh -s -- --host https://your-host:4400 --token <pairing token>

# update in place
sudo brevi worker update

# remove everything the installer created
curl -fsSL https://brevi.dev/install.sh | sudo sh -s -- --uninstall
```

Full documentation, including `--check` preflight output and every flag, is on [brevi.dev](https://brevi.dev).

Docs: [brevi.dev](https://brevi.dev) · Source: [github.com/adapter/brevi](https://github.com/adapter/brevi)
