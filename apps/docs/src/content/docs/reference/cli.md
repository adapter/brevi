---
title: CLI
description: "Reference for the brevi command line: the default invocation, init, start, status and update."
---

The CLI is [`@brevi/cli`](https://www.npmjs.com/package/@brevi/cli), exposed as the `brevi` binary. Run it with `npx @brevi/cli [command]`, or install it globally with `npm install -g @brevi/cli` (see [Getting started](/getting-started/)).

```
brevi [command]

  (none)    Start the orchestrator and open the dashboard in your browser;
            runs init first if there is no config yet
  init      Create the brevi config and choose a sandbox provider
  start     Start the orchestrator headlessly, without opening a browser
  status    Check whether the brevi orchestrator is running
  attach <runId>
            Resume a run's agent conversation inside its retained sandbox
  update    Update @brevi/cli to the latest version published on npm

  -V, --version   Print the version
  -h, --help      Print help
```

There are no global flags beyond `--version` and `--help`, and no environment variables: everything else is read from `~/.brevi/config.json`.

## `brevi`

Running `brevi` with no arguments loads the config, starts the orchestrator (which begins polling Linear), serves the dashboard on `http://localhost:<server.port>` (4400 by default, bound to `127.0.0.1`), and opens it in your default browser. If the browser can't be opened, the URL is printed instead.

On first launch, when there is no `~/.brevi/config.json` yet, it runs the [init flow](#brevi-init) automatically before starting, so a fresh machine goes from zero to dashboard in one command. In a non-interactive terminal (CI, scripts) the auto-init cannot prompt, so a missing config fails immediately with a message instead of hanging; run `brevi init` from an interactive terminal first.

Runs in the foreground; `Ctrl+C` (or `SIGTERM`) shuts down gracefully: polling stops, an active run is aborted, queued runs are cancelled, and run state is flushed to disk.

Fails with an actionable message when the orchestrator can't start, for example a `firecracker` provider on a host without KVM, or a port already in use.

`brevi ui`, the previous name for this invocation, still works as a hidden deprecated alias and will be removed in a future release.

## `brevi init`

Creates `~/.brevi/config.json` and asks exactly one question, the sandbox provider:

| Choice | Meaning |
| --- | --- |
| `auto` | Firecracker on Linux with KVM, the process provider otherwise (recommended) |
| `firecracker` | Linux + KVM required, strongest isolation |
| `process` | No isolation, development only |

Picking `firecracker` on a non-Linux machine prints a warning; the config is still written.

If a config already exists, `init` asks before touching it and **preserves everything else**: credentials, repository mappings, triggers. An unparseable config can be overwritten. A summary is shown before saving, listing the provider, which providers are connected, and the mapped repositories.

Everything except the sandbox provider is configured from the dashboard's Configuration page, and the bare `brevi` invocation runs init automatically on first launch, so an explicit `brevi init` is normally only needed to change the sandbox provider later.

## `brevi start`

Identical to the bare `brevi` invocation, but does not open a browser and never auto-runs init; it fails with an actionable message when there is no config (`run brevi init first`). Use it for headless machines and process managers. The dashboard is still served on the same port.

## `brevi status`

Reads the config for the port and requests `/api/health` with a 2 second timeout.

```sh
$ brevi status
✔ brevi is running on port 4400
  version: 0.1.0
  sandbox provider: process
```

Exits `0` when the orchestrator answers, and `1` when it doesn't (or when there is no config).

## `brevi attach <runId>`

Resumes a finished run's agent conversation, right where it left off, inside its retained sandbox. The dashboard's "Open terminal" button opens the same session as an embedded web terminal.

Calls `POST /api/runs/:id/resume`, which boots the sandbox back up from its retained disk if it isn't already running, and prepares an interactive `claude --resume` session with the run's full history, working directory at the run's checkout. `attach` then opens that session in your terminal: over ssh for Firecracker sandboxes, directly on the host for the process provider.

On exit, `attach` calls `POST /api/runs/:id/release`, which stops the sandbox's compute again; its disk stays until `sandbox.retentionHours` runs out.

Resume works for completed and failed runs and is Claude-only for now (Codex runs report "Resume unavailable", since the run has no captured session id to resume from). Fails with a clear message once the retention window has passed and the sandbox's disk was already reclaimed.

## `brevi update`

Also available as `brevi upgrade`. Asks the npm registry for the latest published `@brevi/cli` and compares it to the running version.

```sh
$ brevi update
! Update available: 0.1.1 → 0.2.0
  What changed: https://brevi.dev/reference/changelog/

Detected a global npm install; running npm install -g @brevi/cli@0.2.0

✔ Updated @brevi/cli 0.1.1 → 0.2.0
  Changelog: https://brevi.dev/reference/changelog/
```

When an update is available it is installed in place, using the package manager the CLI was installed with: global installs via npm, bun, pnpm and yarn are detected from the path the CLI is running from. When running through `npx` (or `bunx` / `pnpm dlx`) there is nothing installed to update; the command says so and points at `npx @brevi/cli@latest`.

brevi is under active development and releases can contain breaking changes, so the [changelog](/reference/changelog/) is always linked before anything is installed.

With `--check`, it only reports and installs nothing. Exit codes: `0` when up to date (or after a successful update), `1` when `--check` found a newer version, when npm is unreachable, or when the install failed.

The bare `brevi` invocation, `brevi start`, and `brevi status` also print a non-blocking one-line notice when a newer version is on npm; the check never delays them and stays silent when npm doesn't answer quickly.
