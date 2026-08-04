---
title: CLI
description: "Reference for the brevi command line: init, ui, start and status."
---

The CLI is `@brevi/cli`, exposed as the `brevi` binary. Until the packages are published, run it from a clone with `bun run brevi -- <command>`, or `bun link` the package once (see [Getting started](/getting-started/)).

```
brevi [command]

  init      Create the brevi config and choose a sandbox provider
  ui        Start the orchestrator and open the dashboard in your browser
  start     Start the orchestrator headlessly, without opening a browser
  status    Check whether the brevi orchestrator is running

  -V, --version   Print the version
  -h, --help      Print help
```

There are no global flags beyond `--version` and `--help`, and no environment variables: everything else is read from `~/.brevi/config.json`.

## `brevi init`

Creates `~/.brevi/config.json` and asks exactly one question — the sandbox provider:

| Choice | Meaning |
| --- | --- |
| `auto` | Firecracker on Linux with KVM, the process provider otherwise (recommended) |
| `firecracker` | Linux + KVM required, strongest isolation |
| `process` | No isolation, development only |

Picking `firecracker` on a non-Linux machine prints a warning; the config is still written.

If a config already exists, `init` asks before touching it and **preserves everything else** — credentials, repository mappings, triggers. An unparseable config can be overwritten. A summary is shown before saving, listing the provider, which providers are connected, and the mapped repositories.

Everything except the sandbox provider is configured from the dashboard's Connections rail, so `init` is normally run once.

## `brevi ui`

Loads the config, starts the orchestrator (which begins polling Linear), serves the dashboard on `http://localhost:<server.port>` — 4400 by default, bound to `127.0.0.1` — and opens it in your default browser. If the browser can't be opened, the URL is printed instead.

Runs in the foreground; `Ctrl+C` (or `SIGTERM`) shuts down gracefully: polling stops, an active run is aborted, queued runs are cancelled, and run state is flushed to disk.

Fails with an actionable message when there is no config (`run brevi init first`) or when the orchestrator can't start — for example a `firecracker` provider on a host without KVM, or a port already in use.

## `brevi start`

Identical to `brevi ui`, but does not open a browser. Use it for headless machines and process managers. The dashboard is still served on the same port.

## `brevi status`

Reads the config for the port and requests `/api/health` with a 2 second timeout.

```sh
$ brevi status
✔ brevi is running on port 4400
  version: 0.1.0
  sandbox provider: process
```

Exits `0` when the orchestrator answers, and `1` when it doesn't (or when there is no config).
