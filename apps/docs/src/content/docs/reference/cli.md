---
title: CLI
description: "Reference for the brevi command line: the default invocation, init, setup, start, status, doctor, worker, and update."
---

The CLI is [`@brevi/cli`](https://www.npmjs.com/package/@brevi/cli), exposed as the `brevi` binary. Run it with `npx @brevi/cli [command]`, or install it globally with `npm install -g @brevi/cli` (see [Getting started](/getting-started/)).

```
brevi [command]

  (none)    Start the orchestrator and open the dashboard in your browser;
            runs init first if there is no config yet
  init      Create the brevi config
  setup     Install bubblewrap and passt so this Linux host can execute isolated runs
  start     Start the orchestrator headlessly, without opening a browser
  status    Check whether the brevi orchestrator is running
  doctor    Check the whole brevi setup: config, server, sandbox,
            connectors, CLIs
  attach <runId>
            Resume a run's agent conversation inside its retained sandbox
  worker    Enroll this machine as a worker, or reconnect an enrolled one
  update    Update @brevi/cli to the latest version published on npm

  -V, --version   Print the version
  -h, --help      Print help
```

There are no global flags beyond `--version` and `--help`, and no environment variables: everything else is read from `~/.brevi/config.json`.

## `brevi`

Running `brevi` with no arguments loads the config, starts the orchestrator (which begins polling Linear), serves the dashboard on `http://localhost:<server.port>` (4400 by default, bound to `server.host`, `127.0.0.1` unless configured), and opens it in your default browser. If the browser can't be opened, the URL is printed instead.

On first launch, when there is no `~/.brevi/config.json` yet, it runs the [init flow](#brevi-init) automatically before starting, so a fresh machine goes from zero to dashboard in one command. In a non-interactive terminal (CI, scripts) the auto-init cannot prompt, so a missing config fails immediately with a message instead of hanging; run `brevi init` from an interactive terminal first.

On Linux, the orchestrator also supervises a local worker when bubblewrap is ready, so this machine can execute runs. On a Mac, or Linux without bubblewrap, it is a scheduler only: labeled tickets queue until a Linux worker is online.

Runs in the foreground; `Ctrl+C` (or `SIGTERM`) shuts down gracefully: polling stops, an active run is aborted, queued runs are cancelled, and run state is flushed to disk.

Fails with an actionable message when the orchestrator can't start, for example a port already in use.

`brevi ui`, the previous name for this invocation, still works as a hidden deprecated alias and will be removed in a future release.

## `brevi init`

Creates `~/.brevi/config.json`. It no longer asks which sandbox to use: every run executes in a bwrap sandbox on a Linux worker.

If a config already exists, `init` asks before touching it and **preserves everything else**: credentials, repository mappings, triggers. An unparseable config can be overwritten. A summary is shown before saving, listing which providers are connected and the mapped repositories.

Everything else is configured from the dashboard's Configuration page, and the bare `brevi` invocation runs init automatically on first launch, so an explicit `brevi init` is normally only needed once.

On Linux, when bubblewrap is missing (or user namespaces do not work), init offers to run [`brevi setup`](#brevi-setup) inline. Declining changes nothing.

Init then checks for the external CLIs brevi shells out to: `claude`, `codex`, `gh`, and `wrangler`. Agent CLIs live on the worker that executes the run (host `PATH`, bind-mounted into the sandbox). `gh` and `wrangler` are always optional, used by the dashboard's Connect flow and the R2 connector respectively. For each missing tool, init offers to install it; declining or a failed install never fails init, it just gets reported. The step ends with a per-tool status line, and re-running `brevi init` repeats the check.

## `brevi setup`

```
brevi setup [-y, --yes]
```

Installs [bubblewrap](https://github.com/containers/bubblewrap) and [passt](https://passt.top/) on this Linux host so it can execute isolated runs. Interactive and idempotent: if `bwrap` and `pasta` are already on `PATH`, setup skips the install and only probes unprivileged user namespaces.

| Flag | Meaning |
| --- | --- |
| `-y, --yes` | Install missing packages without prompting |

On a missing `bwrap` or `pasta`, setup offers `sudo apt-get install -y` for whichever packages are absent (or runs it immediately with `--yes`). It then runs the same readiness check `brevi doctor` uses: Linux, `bwrap` and `pasta` on `PATH`, and a production-shaped namespace probe. When that passes, this machine can execute runs. Remaining problems are listed instead, and setup exits non-zero.

Requires Linux; on other platforms there is nothing to set up (this machine stays a scheduler). The [Linux worker installer](/guides/workers/) installs bubblewrap and passt as root itself rather than calling this command as the unprivileged `brevi` user.

## `brevi start`

Identical to the bare `brevi` invocation, but does not open a browser and never auto-runs init; it fails with an actionable message when there is no config (`run brevi init first`). Use it for headless machines and process managers. The dashboard is still served on the same port.

## `brevi status`

Reads the config for the port and requests `/api/health` with a 2 second timeout.

```sh
$ brevi status
✔ brevi is running on port 4400
  version: 0.1.0
  sandbox provider: bwrap
```

Exits `0` when the orchestrator answers, and `1` when it doesn't (or when there is no config). `sandbox provider` is the provider the host reports (`bwrap` on current releases).

## `brevi doctor`

Runs a read-only checklist over the whole local setup and prints one line per check: a green pass, a yellow warning, a red failure, or a dim skip, with an indented fix hint under each failure.

Five sections, roughly in dependency order:

1. **Config**: `~/.brevi/config.json` exists, is valid JSON, and passes the schema; unknown keys (typos, leftovers from an older version) come back as warnings.
2. **Server**: the pid file against reality (running and healthy, not running, a stale or unreadable pid file left by a crash, or the port held by something that isn't brevi, even one that answers no HTTP), plus the running server's version against the installed CLI, to catch an update that hasn't been restarted yet. The probe targets the configured `server.host` (loopback for the default and wildcard binds), a healthy answer must report `ok`, and a healthy server whose pid file doesn't match the responder is flagged too.
3. **Sandbox**: whether this machine can run bwrap (Linux, bubblewrap and passt on `PATH`, unprivileged user namespaces). When it can, also that `agent.command` resolves on `PATH`, `~/.brevi` is writable, and the Playwright browser cache (`~/.brevi/cache/ms-playwright`) is writable or creatable. A Mac (or Linux without bwrap) is a warning, not a failure: enroll a Linux worker instead.
4. **Connectors**: the Linear token, verified with a cheap authenticated call; the GitHub token, verified plus its scopes checked (`repo` required, `workflow` recommended), and push access to every configured repository confirmed with a cheap read-only call per repo, which also covers fine-grained tokens (they don't report scopes); Claude, Codex, and Grok agent credentials saved in the config, which is what runs actually consume (a credential that is merely discoverable on the host fails, or warns for the optional Codex review, with a hint to connect it from the dashboard); R2, only when configured, checking wrangler is installed and logged in and the configured bucket is reachable, both probes sharing one 10 second budget.
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
  ✔ bwrap             ready (Linux, bubblewrap, passt, user namespaces)
  ✔ agent CLI         claude at /usr/local/bin/claude
  ✔ state dir         ~/.brevi is writable
```

Exits `0` when every check passes (warnings and skips don't count against it), `1` when any check fails, so it's scriptable in CI or as a pre-flight hook.

When at least one check fails and the `claude` CLI is installed, doctor offers a second stage: a non-interactive `claude -p` call, pinned to the current Sonnet model regardless of whichever models are configured for agents, that reads the check results, the config with secrets masked, the tail of the orchestrator log (`~/.brevi/logs/orchestrator.log`, where the server tees its console output), and the tail of the most recent run's event log as supplemental evidence, then explains the likely root cause with concrete fix steps. It's strictly read-only: Claude runs with its entire tool set disabled and user and project customizations (plugins, hooks, MCP servers) turned off, no permission skipping, and every raw secret value, including the individual tokens inside a Codex `auth.json` login, is scrubbed from the bundled evidence before it is sent. It never changes doctor's exit code. In an interactive terminal it asks first; `brevi doctor --ai` runs it without asking, which is also how to get it in scripts. Without `claude` installed, the stage is skipped and doctor is otherwise fully functional.

## `brevi attach <runId>`

Resumes a finished run's agent conversation, right where it left off, inside its retained sandbox. The dashboard's "Open terminal" button opens the same session as an embedded web terminal.

Calls `POST /api/runs/:id/resume`, which asks the worker that executed the run to boot the sandbox back up from its retained disk if it isn't already running, and prepares an interactive `claude --resume` session with the run's full history, working directory at the run's checkout. `attach` then bridges your terminal to that session over the host's `/ws/runs/:id/attach` WebSocket, which relays to a PTY on the worker holding the run's sandbox.

On exit, `attach` calls `POST /api/runs/:id/release`, which stops the sandbox's compute again; its disk stays until `sandbox.retentionHours` runs out.

Resume works for completed and failed runs and is Claude-only for now (Codex runs report "Resume unavailable", since the run has no captured session id to resume from). Fails with a clear message once the retention window has passed and the sandbox's disk was already reclaimed. Only bwrap sandboxes can be reattached.

## `brevi worker`

```
brevi worker --host <url> [--token <token>] [--name <name>] [--concurrency <n>]
```

Runs an execution worker: a machine willing to execute the runs a `brevi` host dispatches to it. The host itself is a scheduler and never touches a sandbox; every run's sandbox lives on whichever worker executed it. A worker only ever dials out to the host, over a single outbound WebSocket, and never listens itself.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--host <url>` | required | The brevi host to work for, e.g. `http://192.168.1.5:4400` |
| `--token <token>` | none | Single-use pairing token, needed only to enroll this machine (or to enroll it again after a revoke) |
| `--name <name>` | this machine's hostname | Name to enroll under; the host keeps its own name for this worker afterwards |
| `--concurrency <n>` | this machine's local `sandbox.concurrency` | How many dispatched runs to execute at once |

`--host` is required and has no fallback to this machine's own config: which brevi instance a worker belongs to is the host's business, not something the worker's config (if it even has one) could know. It has to be an address the worker can reach, either the host machine's own address for a worker running there, or the address the host's `fleet.host` listener is bound to for a worker elsewhere (see [Configuration](/reference/configuration/#fleet) and [Workers](/guides/workers/)).

`--concurrency` accepts an integer from 1 to 64; anything outside that range is rejected before the worker connects, since the host's registration schema would otherwise refuse it and leave the process looking like it's merely reconnecting. A machine with no `~/.brevi/config.json` at all, the normal case for one that only ever runs `brevi worker`, falls back to the schema's own defaults: concurrency 1.

`--token` is a pairing token minted on the host's Workers page (Configuration > Workers, `/config/workers`): "Add a worker" there mints one and shows this exact command, ready to copy, with the host address and the token already filled in. The token is single-use and expires 15 minutes after minting, and redeeming it is what enrolls this machine: the host assigns it an id and answers with a durable per-worker credential, stored at `~/.brevi/worker.json` (mode `0600`, the only fleet secret this machine keeps, and scoped to the host that issued it). Every later `brevi worker --host <url>` reconnects with that credential and needs no `--token` at all.

A `--token` passed alongside a stored credential is tried first regardless, which is how a machine whose enrollment was revoked re-enrolls in one command. If the host refuses that token as invalid or expired and a stored credential is still there, the worker falls back to reconnecting with the credential instead of exiting. Starting with neither a `--token` nor an enrollment for that host fails immediately, before the sandbox preflight below, pointing at "Add a worker" on the host.

`--name` only picks the name this machine enrolls under, and the host keeps its own name for the worker from then on: rename it from the Workers page rather than by restarting with a different `--name`.

The worker's `sandbox.*` settings (concurrency, timeout, retention) always come from its own local `~/.brevi/config.json`, never from the host. Before the first connect it resolves and preflights the sandbox (Linux, bubblewrap and passt on `PATH`, unprivileged user namespaces). A host that cannot run bwrap still connects, but the host will not dispatch runs to it.

Every registration reports the worker's capabilities: OS, architecture, the sandbox provider (`bwrap`), available agent commands, concurrency, and brevi version. The scheduler only dispatches a run to a worker that advertises its configured agent command. While connected the worker heartbeats every 15 seconds with the leases it still holds; a worker silent for longer than the host's `fleet.heartbeatTimeoutSeconds` (45 by default) is dropped, and one that dropped mid-run has `fleet.reconnectGraceSeconds` (120 by default) to reconnect and resume reporting before its runs are failed.

Draining the worker from the Workers page reaches it over that same connection and takes effect at once: it refuses new dispatches with "worker is draining" while the runs already in flight finish and report normally, and the state survives reconnects, so a machine being decommissioned empties itself. Re-enabling it puts it back in rotation. Revoking it kills its credential and disconnects it immediately: the worker deletes its stored credential, shuts down what it was still running, and exits non-zero rather than retrying, since reconnecting with a dead credential would only produce a rejection loop. Enrolling that machine again needs a fresh pairing token.

Runs in the foreground until `Ctrl+C` (or `SIGTERM`). The first signal stops the worker from accepting new dispatches, aborts whatever runs are still in flight, and waits for their final reporting to reach the host before the process exits; a second signal exits immediately instead of waiting. Reconnects on its own with exponential backoff (jittered, capped at 30 seconds) whenever the connection drops, resuming in-flight run reporting once it registers again; a rejection that retrying cannot fix, a dead credential or a protocol mismatch, is fatal and exits non-zero instead.

Losing the connection does not pause a run: the worker keeps executing whatever it was dispatched and buffers its patches, events and artifacts locally while the host is unreachable, then replays that backlog, deduplicated, once it reconnects. A host that is restarted mid-run, or a brief network drop, does not truncate the run's console or lose its final result.

### `brevi worker update`

```
brevi worker update [--check] [--version <v>]
```

Upgrades an installed **standalone worker binary**, the single-file executable the [worker installer](/guides/workers/) places at `/usr/local/bin/brevi`, in place, without touching `~/.brevi/config.json` or `~/.brevi/worker.json`, so enrollment survives. Run against an npm install (global, `npx`, etc.) it reports that there's no standalone binary to replace and points at [`brevi update`](#brevi-update) instead.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--check` | off | Only report whether a newer version exists; installs nothing |
| `--version <v>` | latest on npm | Install this exact `@brevi/cli` version instead of the latest |

The binary is replaced first, and the rest of the update then runs as the release that was just installed: replacing an executable leaves the running process on the old one, so once the new binary is on disk it is re-executed to finish the job (restart `brevi-worker.service` when that systemd unit is installed). A manifest naming a different release or architecture than the one asked for is refused before anything is downloaded.

Downloads the target version's binary from the same source the [installer](/guides/workers/) uses, then restarts `brevi-worker.service` when that systemd unit is installed (as root directly, or by printing the `systemctl restart` command to run yourself otherwise). Exits `0` when already up to date or after a successful update, `1` when `--check` found a newer version, when the download failed, or when the installed unit's restart failed (the binary may already be in place, but the running daemon is still on the old one until it restarts).

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
