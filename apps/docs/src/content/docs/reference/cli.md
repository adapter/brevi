---
title: CLI
description: "Reference for the brevi command line: the default invocation, init, setup, start, status, doctor, worker and update."
---

The CLI is [`@brevi/cli`](https://www.npmjs.com/package/@brevi/cli), exposed as the `brevi` binary. Run it with `npx @brevi/cli [command]`, or install it globally with `npm install -g @brevi/cli` (see [Getting started](/getting-started/)).

```
brevi [command]

  (none)    Start the orchestrator and open the dashboard in your browser;
            runs init first if there is no config yet
  init      Create the brevi config and choose a sandbox provider
  setup     Set up the firecracker sandbox on this host
            (kvm, binary, kernel, rootfs, network)
  start     Start the orchestrator headlessly, without opening a browser
  status    Check whether the brevi orchestrator is running
  doctor    Check the whole brevi setup: config, server, sandbox,
            connectors, CLIs
  attach <runId>
            Resume a run's agent conversation inside its retained sandbox
  worker    Run an execution worker that connects to a brevi host and
            executes dispatched runs
  update    Update @brevi/cli to the latest version published on npm

  -V, --version   Print the version
  -h, --help      Print help
```

There are no global flags beyond `--version` and `--help`, and no environment variables: everything else is read from `~/.brevi/config.json`.

## `brevi`

Running `brevi` with no arguments loads the config, starts the orchestrator (which begins polling Linear), serves the dashboard on `http://localhost:<server.port>` (4400 by default, bound to `server.host`, `127.0.0.1` unless configured), and opens it in your default browser. If the browser can't be opened, the URL is printed instead.

On first launch, when there is no `~/.brevi/config.json` yet, it runs the [init flow](#brevi-init) automatically before starting, so a fresh machine goes from zero to dashboard in one command. In a non-interactive terminal (CI, scripts) the auto-init cannot prompt, so a missing config fails immediately with a message instead of hanging; run `brevi init` from an interactive terminal first.

Runs in the foreground; `Ctrl+C` (or `SIGTERM`) shuts down gracefully: polling stops, an active run is aborted, queued runs are cancelled, and run state is flushed to disk.

Fails with an actionable message when the orchestrator can't start, for example a `firecracker` provider on a host without KVM, or a port already in use.

`brevi ui`, the previous name for this invocation, still works as a hidden deprecated alias and will be removed in a future release.

## `brevi init`

Creates `~/.brevi/config.json` and asks exactly one configuration question, the sandbox provider:

| Choice | Meaning |
| --- | --- |
| `auto` | Firecracker when the host passes the full preflight (Linux, KVM, binary, images, key), the process provider otherwise (recommended) |
| `firecracker` | Linux + KVM required, strongest isolation |
| `process` | No isolation, development only |

Picking `firecracker` on a non-Linux machine prints a warning; the config is still written.

If a config already exists, `init` asks before touching it and **preserves everything else**: credentials, repository mappings, triggers. An unparseable config can be overwritten. A summary is shown before saving, listing the provider, which providers are connected, and the mapped repositories.

Everything except the sandbox provider is configured from the dashboard's Configuration page, and the bare `brevi` invocation runs init automatically on first launch, so an explicit `brevi init` is normally only needed to change the sandbox provider later.

On Linux, when the saved provider is `auto` or `firecracker` but the host isn't provisioned yet, init offers to run [`brevi setup`](#brevi-setup) inline. Declining changes nothing.

Init then checks for the external CLIs brevi shells out to: `claude`, `codex`, `gh`, and `wrangler`. The agent CLIs (`claude`, `codex`) are only required on the host when runs execute with the process provider; under firecracker they ship inside the sandbox image, so they're checked but optional on the host. `gh` and `wrangler` are always optional, used by the dashboard's Connect flow and the R2 connector respectively. For each missing tool, init offers to install it; declining or a failed install never fails init, it just gets reported. The step ends with a per-tool status line, and re-running `brevi init` repeats the check.

## `brevi setup`

Provisions the current Linux host for the [Firecracker sandbox](/guides/sandboxes/). Interactive and idempotent: each step checks itself first and is skipped with a note when already satisfied, so re-running after a reboot or a partial first run is safe.

The steps, in order:

1. **Host tools**: checks for `ip`, `ssh`, `tar`, `iptables` and `docker`, and offers to install the missing ones with apt (asks first; on non-apt systems an install hint is printed instead). docker is only needed to build the rootfs from source, iptables only for networking.
2. **KVM**: when `/dev/kvm` exists but isn't accessible, offers to add your user to the `kvm` group (takes effect after a re-login); when it's missing entirely, points at `modprobe`.
3. **Firecracker binary**: when none resolves on `PATH` (or at `sandbox.firecracker.binary`), downloads the official release to `~/.brevi/bin/firecracker` (sha256-verified against a pinned digest) and points the config at it.
4. **Kernel**: downloads a known-good `vmlinux` (sha256-verified against a pinned digest) to the configured kernel path when missing.
5. **Rootfs + ssh key**: downloads the prebuilt, checksum-verified rootfs image, no Docker needed, and caches it under `~/.brevi/cache/rootfs/`; building from source with docker (takes several minutes; asks first) remains the fallback. Generates the ssh keypair if missing.
6. **Networking**: creates the tap device pool and NAT rules (asks first; not persistent across reboots).

brevi never escalates privileges silently: every `sudo` command line is printed before it runs, and every step that uses one asks first. Setup ends with the same complete preflight check `brevi start` uses, including networking (tap devices and IPv4 forwarding) and the rootfs manifest version; when everything passes, setup offers to switch `sandbox.provider` from `process` to `firecracker` and reports the sandbox ready. Remaining problems are listed instead, with a pointer to re-run once fixed, and setup exits non-zero.

Requires an interactive terminal and Linux; on other platforms there is nothing to set up, since the `auto` provider selects the [process provider](/guides/sandboxes/#the-process-provider) there (an explicit `firecracker` provider fails at startup instead). Works without a config too (`brevi init` picks the provisioned host up afterwards).

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

## `brevi doctor`

Runs a read-only checklist over the whole local setup and prints one line per check: a green pass, a yellow warning, a red failure, or a dim skip, with an indented fix hint under each failure.

Five sections, roughly in dependency order:

1. **Config**: `~/.brevi/config.json` exists, is valid JSON, and passes the schema; unknown keys (typos, leftovers from an older version) come back as warnings.
2. **Server**: the pid file against reality (running and healthy, not running, a stale or unreadable pid file left by a crash, or the port held by something that isn't brevi, even one that answers no HTTP), plus the running server's version against the installed CLI, to catch an update that hasn't been restarted yet. The probe targets the configured `server.host` (loopback for the default and wildcard binds), a healthy answer must report `ok`, and a healthy server whose pid file doesn't match the responder is flagged too.
3. **Sandbox**: for Firecracker (explicit, or `auto` on Linux), the same complete preflight `brevi start` uses: KVM, binary, kernel, rootfs (a resolvable image, from-source or downloaded and cached, whose manifest version matches brevi's; a mismatch fails with a hint to update the image or update brevi), ssh key, tap devices, and IPv4 forwarding. An unprovisioned host is a warning under `auto` (it falls back to the process provider) and a failure under an explicit `firecracker` provider. For the process provider: `agent.command` resolves on `PATH`, `~/.brevi` is writable, and the Playwright browser cache (`~/.brevi/cache/ms-playwright`) is writable or creatable.
4. **Connectors**: the Linear token, verified with a cheap authenticated call; the GitHub token, verified plus its scopes checked (`repo` required, `workflow` recommended), and push access to every configured repository confirmed with a cheap read-only call per repo, which also covers fine-grained tokens (they don't report scopes); Claude and Codex agent credentials saved in the config, which is what runs actually consume (a credential that is merely discoverable on the host fails, or warns for the optional Codex review, with a hint to connect it from the dashboard); R2, only when configured, checking wrangler is installed and logged in and the configured bucket is reachable, both probes sharing one 10 second budget.
5. **External CLIs**: presence and version of `claude`, `codex`, `gh`, and `wrangler`. Purely informational here, since a CLI that's actually required already failed an earlier section; missing optional ones just show as dim skips.

Network probes run with short timeouts, so a full pass takes a few seconds.

```sh
$ brevi doctor
Config
  ✔ config file       ~/.brevi/config.json parses and passes the schema
Server
  ✖ server            not running
                      ↳ Start it with `brevi start` (or `npx @brevi/cli`).
Sandbox
  ✔ agent CLI         claude at /usr/local/bin/claude
  ✔ state dir         ~/.brevi is writable
```

Exits `0` when every check passes (warnings and skips don't count against it), `1` when any check fails, so it's scriptable in CI or as a pre-flight hook.

When at least one check fails and the `claude` CLI is installed, doctor offers a second stage: a non-interactive `claude -p` call, pinned to the current Sonnet model regardless of whichever models are configured for agents, that reads the check results, the config with secrets masked, the tail of the orchestrator log (`~/.brevi/logs/orchestrator.log`, where the server tees its console output), and the tail of the most recent run's event log as supplemental evidence, then explains the likely root cause with concrete fix steps. It's strictly read-only: Claude runs with its entire tool set disabled and user and project customizations (plugins, hooks, MCP servers) turned off, no permission skipping, and every raw secret value, including the individual tokens inside a Codex `auth.json` login, is scrubbed from the bundled evidence before it is sent. It never changes doctor's exit code. In an interactive terminal it asks first; `brevi doctor --ai` runs it without asking, which is also how to get it in scripts. Without `claude` installed, the stage is skipped and doctor is otherwise fully functional.

## `brevi attach <runId>`

Resumes a finished run's agent conversation, right where it left off, inside its retained sandbox. The dashboard's "Open terminal" button opens the same session as an embedded web terminal.

Calls `POST /api/runs/:id/resume`, which boots the sandbox back up from its retained disk if it isn't already running, on whichever worker executed the run, and prepares an interactive `claude --resume` session with the run's full history, working directory at the run's checkout. `attach` then bridges your terminal to that session over the host's `/ws/runs/:id/attach` WebSocket, which relays to a PTY on the worker holding the run's sandbox.

On exit, `attach` calls `POST /api/runs/:id/release`, which stops the sandbox's compute again; its disk stays until `sandbox.retentionHours` runs out.

Resume works for completed and failed runs and is Claude-only for now (Codex runs report "Resume unavailable", since the run has no captured session id to resume from). Fails with a clear message once the retention window has passed and the sandbox's disk was already reclaimed.

## `brevi worker`

```
brevi worker [--host <url>] [--token <token>] [--name <name>] [--concurrency <n>]
```

Runs an execution worker: a machine willing to execute runs a `brevi` host dispatches to it. The host itself is a pure scheduler and never touches a sandbox; every run's sandbox lives on whichever worker executed it. A worker only ever dials out to the host, over a single outbound WebSocket, and never listens itself.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--host <url>` | `http://localhost:<server.port>` from this machine's local config | The brevi host to connect to |
| `--token <token>` | this machine's local config's `fleet.token` | Pairing token; the host generates one on first start |
| `--name <name>` | this machine's hostname | Shown for this worker on the host's dashboard |
| `--concurrency <n>` | this machine's local config's `sandbox.concurrency` | How many dispatched runs to execute at once |

`--concurrency` accepts an integer from 1 to 64; anything outside that range is rejected before the worker connects, since the host's registration schema would otherwise refuse it and leave the process looking like it's merely reconnecting.

The worker's `sandbox.*` settings (which provider, Firecracker image paths, VM size) always come from its own local `~/.brevi/config.json`, never from the host: a worker's provider and images are local to its machine, so a dispatch's own `sandbox.*` fields are overridden with the worker's before it executes.

Fails with an actionable message when no pairing token is available (neither `--token` nor a local `fleet.token`) or when the local config has none, in either case pointing at where to find or set one.

Runs in the foreground until `Ctrl+C` (or `SIGTERM`). The first signal stops the worker from accepting new dispatches, aborts whatever runs are still in flight, and waits for their final reporting to reach the host before the process exits; a second signal exits immediately instead of waiting. Reconnects on its own with exponential backoff whenever the connection drops, resuming in-flight run reporting once it registers again; a rejected pairing token is fatal and exits non-zero instead, since it will not fix itself by retrying.

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
