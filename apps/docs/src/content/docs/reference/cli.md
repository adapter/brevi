---
title: CLI
description: "Reference for the brevi command line: the default invocation, start, status, doctor, worker, mac and update."
---

The CLI is [`@brevi/cli`](https://www.npmjs.com/package/@brevi/cli), exposed as the `brevi` binary. Run it with `npx @brevi/cli [command]`, or install it globally with `npm install -g @brevi/cli` (see [Getting started](/getting-started/)).

```
brevi [command]

  (none)    Start the orchestrator and open the dashboard in your browser;
            first launch writes the config, provisions Firecracker on
            Linux, and opens /setup
  start     Start the orchestrator headlessly, without opening a browser
  status    Check whether the brevi orchestrator is running
  doctor    Check the whole brevi setup: config, server, sandbox,
            connectors, CLIs
  attach <runId>
            Resume a run's agent conversation inside its retained sandbox
  worker    Enroll this machine as a worker, or reconnect an enrolled one
  mac       Manage a fully isolated Firecracker worker in a Linux VM on
            Apple silicon (M3+, macOS 15+)
  update    Update @brevi/cli to the latest version published on npm

  -V, --version   Print the version
  -h, --help      Print help
```

There are no global flags beyond `--version` and `--help`, and no environment variables: everything else is read from `~/.brevi/config.json`.

## `brevi`

Running `brevi` with no arguments loads the config, starts the orchestrator (which begins polling Linear), serves the dashboard on `http://localhost:<server.port>` (4400 by default, bound to `server.host`, `127.0.0.1` unless configured), and opens it in your default browser. If the browser can't be opened, the URL is printed instead.

On first launch, when there is no `~/.brevi/config.json` yet, it writes schema defaults, provisions the [Firecracker sandbox](/guides/sandboxes/) on Linux (binary, kernel, rootfs, tap network), then opens the dashboard at `/setup` so you can pick a sandbox provider and connect Linear, GitHub, and an agent. A non-interactive terminal (CI, scripts) still writes the default config and starts; it skips Firecracker provisioning so it never hangs on a prompt or `sudo`.

Runs in the foreground; `Ctrl+C` (or `SIGTERM`) shuts down gracefully: polling stops, an active run is aborted, queued runs are cancelled, and run state is flushed to disk.

Fails with an actionable message when the orchestrator can't start, for example a `firecracker` provider on a host without KVM, or a port already in use.

`brevi ui`, the previous name for this invocation, still works as a hidden deprecated alias and will be removed in a future release.

## `brevi setup`

```
brevi setup [-y, --yes] [--skip-network] [--set-provider]
```

Hidden. The same Firecracker provisioning first launch runs on Linux, kept for the [Linux worker installer](/guides/workers/) and `brevi mac install`. Interactive and idempotent: each step checks itself first and is skipped with a note when already satisfied, so re-running after a reboot or a partial first run is safe.

| Flag | Meaning |
| --- | --- |
| `-y, --yes` | Answer every prompt with its default-yes and never wait for input, for unattended provisioning; no interactive terminal is required in this mode |
| `--skip-network` | Skip the networking step. For a caller that provisions tap devices and NAT rules itself, for example the [Linux worker installer](/guides/workers/)'s systemd unit, which re-runs `setup-network.sh` as root on every boot instead of relying on this one-shot step. |
| `--set-provider` | Set `sandbox.provider` to `firecracker` once setup succeeds, instead of asking, and write the firecracker settings this run provisioned along with it (creating the config when the machine has none). |

`--yes` picks the path that needs no human and no extra host dependency: it accepts apt package installs, but declines a from-source rootfs build (and never installs docker) in favor of the prebuilt rootfs download, logging what it skipped and how to do it manually. The [Linux worker installer](/guides/workers/) runs `brevi setup --yes --skip-network --set-provider` to provision Firecracker unattended as its service user. First launch of `brevi` on an interactive Linux terminal runs the same flow with `--yes`.

The steps, in order:

1. **Host tools**: checks for `ip`, `ssh`, `tar`, `iptables` and `docker`, and offers to install the missing ones with apt (asks first; on non-apt systems an install hint is printed instead). docker is only needed to build the rootfs from source, iptables only for networking.
2. **KVM**: when `/dev/kvm` exists but isn't accessible, offers to add your user to the `kvm` group (takes effect after a re-login); when it's missing entirely, points at `modprobe`.
3. **Firecracker binary**: when none resolves on `PATH` (or at `sandbox.firecracker.binary`), downloads the official release to `~/.brevi/bin/firecracker` (sha256-verified against a pinned digest) and points the config at it.
4. **Kernel**: downloads a known-good `vmlinux` (sha256-verified against a pinned digest) to the configured kernel path when missing.
5. **Rootfs + ssh key**: downloads the prebuilt, checksum-verified rootfs image, no Docker needed, and caches it under `~/.brevi/cache/rootfs/`; building from source with docker (takes several minutes; asks first) remains the fallback. Generates the ssh keypair if missing.
6. **Networking**: creates the tap device pool and NAT rules (asks first; not persistent across reboots).

brevi never escalates privileges silently: every `sudo` command line is printed before it runs, and every step that uses one asks first. Setup ends with the same complete preflight check `brevi start` uses, including networking (tap devices and IPv4 forwarding) and the rootfs manifest version; when everything passes, setup offers to switch `sandbox.provider` from `process` to `firecracker` (asking, unless `--set-provider` already answered) and reports the sandbox ready. Remaining problems are listed instead, with a pointer to re-run once fixed, and setup exits non-zero.

Requires Linux and, without `--yes`, an interactive terminal; on other platforms there is nothing to set up, since the `auto` provider selects the [process provider](/guides/sandboxes/#the-process-provider) there (an explicit `firecracker` provider fails at startup instead).

## `brevi start`

Identical to the bare `brevi` invocation, but does not open a browser. On first launch it still writes the default config and, on an interactive Linux terminal, provisions Firecracker. Use it for headless machines and process managers. The dashboard is still served on the same port.

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
brevi worker --host <url> [--token <token>] [--name <name>] [--concurrency <n>]
```

Runs an execution worker: a machine willing to execute the runs a `brevi` host dispatches to it. The host itself is a pure scheduler and never touches a sandbox; every run's sandbox lives on whichever worker executed it. A worker only ever dials out to the host, over a single outbound WebSocket, and never listens itself.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--host <url>` | required | The brevi host to work for, e.g. `http://192.168.1.5:4400` |
| `--token <token>` | none | Single-use pairing token, needed only to enroll this machine (or to enroll it again after a revoke) |
| `--name <name>` | this machine's hostname | Name to enroll under; the host keeps its own name for this worker afterwards |
| `--concurrency <n>` | this machine's local `sandbox.concurrency` | How many dispatched runs to execute at once |

`--host` is required and has no fallback to this machine's own config: which brevi instance a worker belongs to is the host's business, not something the worker's config (if it even has one) could know. It has to be an address the worker can reach, either the host machine's own address for a worker running there, or the address the host's `fleet.host` listener is bound to for a worker elsewhere (see [Configuration](/reference/configuration/#fleet) and [Running on another machine](/guides/sandboxes/#running-on-another-machine)).

`--concurrency` accepts an integer from 1 to 64; anything outside that range is rejected before the worker connects, since the host's registration schema would otherwise refuse it and leave the process looking like it's merely reconnecting. A machine with no `~/.brevi/config.json` at all, the normal case for one that only ever runs `brevi worker`, falls back to the schema's own defaults: the process provider at concurrency 1.

`--token` is a pairing token minted on the host's Workers page (Configuration > Workers, `/config/workers`): "Add a worker" there mints one and shows this exact command, ready to copy, with the host address and the token already filled in. The token is single-use and expires 15 minutes after minting, and redeeming it is what enrolls this machine: the host assigns it an id and answers with a durable per-worker credential, stored at `~/.brevi/worker.json` (mode `0600`, the only fleet secret this machine keeps, and scoped to the host that issued it). Every later `brevi worker --host <url>` reconnects with that credential and needs no `--token` at all.

A `--token` passed alongside a stored credential is tried first regardless, which is how a machine whose enrollment was revoked re-enrolls in one command. If the host refuses that token as invalid or expired and a stored credential is still there, the worker falls back to reconnecting with the credential instead of exiting. Starting with neither a `--token` nor an enrollment for that host fails immediately, before the sandbox preflight below (which can take minutes), pointing at "Add a worker" on the host.

`--name` only picks the name this machine enrolls under, and the host keeps its own name for the worker from then on: rename it from the Workers page rather than by restarting with a different `--name`.

The worker's `sandbox.*` settings (which provider, Firecracker image paths, VM size) always come from its own local `~/.brevi/config.json`, never from the host: a worker's provider and images are local to its machine, so a dispatch's own `sandbox.*` fields are overridden with the worker's before it executes. Before the first connect it resolves and preflights that provider the same way the orchestrator does (binary, host tools, kernel, rootfs, ssh keys, tap devices, IP forwarding), so the provider it reports is one that can really boot a run; `auto` downgrades to the process provider when the Firecracker preflight fails, and an explicit `process` is taken as-is. That check runs once at startup and can take a while, since on a fully provisioned Linux host it may download the prebuilt rootfs image.

Every registration reports the worker's capabilities: OS, architecture, the resolved sandbox provider, whether `/dev/kvm` is usable, its concurrency, the Firecracker VM size presets it can boot, and its brevi version. While connected it heartbeats every 15 seconds with the leases it still holds; a worker silent for longer than the host's `fleet.heartbeatTimeoutSeconds` (45 by default) is dropped, and one that dropped mid-run has `fleet.reconnectGraceSeconds` (120 by default) to reconnect and resume reporting before its runs are failed.

Draining the worker from the Workers page reaches it over that same connection and takes effect at once: it refuses new dispatches with "worker is draining" while the runs already in flight finish and report normally, and the state survives reconnects, so a machine being decommissioned empties itself. Re-enabling it puts it back in rotation. Revoking it kills its credential and disconnects it immediately: the worker deletes its stored credential, shuts down what it was still running, and exits non-zero rather than retrying, since reconnecting with a dead credential would only produce a rejection loop. Enrolling that machine again needs a fresh pairing token.

Runs in the foreground until `Ctrl+C` (or `SIGTERM`). The first signal stops the worker from accepting new dispatches, aborts whatever runs are still in flight, and waits for their final reporting to reach the host before the process exits; a second signal exits immediately instead of waiting. Reconnects on its own with exponential backoff (jittered, capped at 30 seconds) whenever the connection drops, resuming in-flight run reporting once it registers again; a rejection that retrying cannot fix, a dead credential or a protocol mismatch, is fatal and exits non-zero instead.

Losing the connection does not pause a run: the worker keeps executing whatever it was dispatched and buffers its patches, events and artifacts locally while the host is unreachable, then replays that backlog, deduplicated, once it reconnects. A host that is restarted mid-run, or a brief network drop, does not truncate the run's console or lose its final result.

### `brevi worker update`

```
brevi worker update [--check] [--version <v>]
```

Upgrades an installed **standalone worker binary**, the single-file executable the [worker installer](/guides/workers/) places at `/usr/local/bin/brevi`, and its prebuilt rootfs image in place, without touching `~/.brevi/config.json` or `~/.brevi/worker.json`, so enrollment survives. Run against an npm install (global, `npx`, etc.) it reports that there's no standalone binary to replace and points at [`brevi update`](#brevi-update) instead.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--check` | off | Only report whether a newer version exists; installs nothing |
| `--version <v>` | latest on npm | Install this exact `@brevi/cli` version instead of the latest |

Run as root on a machine with the unit installed (`sudo brevi worker update`), it acts on the `brevi` service user's own `~/.brevi`, resolved from `getent passwd`, rather than root's: the config it reads, the rootfs cache it downloads into, and the ownership of what it wrote are all the daemon's, so a multi-gigabyte image never lands in a directory the worker never looks at.

A machine that pins its own image with `sandbox.firecracker.rootfs` is refused rather than overridden: that setting means brevi never consults its managed cache, so an image the new release cannot use is something only you can replace, and downloading one anyway would report success while leaving the worker unable to start. The update stops before downloading anything, says what is wrong with the pinned image, and leaves the service running.

The binary is replaced first, and the rest of the update then runs as the release that was just installed: replacing an executable leaves the running process on the old one, and which rootfs image a release wants (down to the image contract it will accept) is a question only that release can answer, so once the new binary is on disk it is re-executed to finish the job. A manifest naming a different release or architecture than the one asked for is refused before anything is downloaded.

Downloads the target version's binary and rootfs image from the same source [`brevi setup`](#brevi-setup) uses, then restarts `brevi-worker.service` when that systemd unit is installed (as root directly, or by printing the `systemctl restart` command to run yourself otherwise). Exits `0` when already up to date or after a successful update, `1` when `--check` found a newer version, when the download failed, or when the installed unit's restart failed (the binary and/or image may already be in place, but the running daemon is still on the old one until it restarts).

## `brevi mac`

```
brevi mac install [--host <url>] [--token <token>] [--cpus <n>] [--memory <gib>] [--disk <gib>]
                  [--idle-stop <minutes>] [--concurrency <n>] [--name <name>] [-y, --yes]
brevi mac status
brevi mac start
brevi mac stop
brevi mac uninstall [-y, --yes]
brevi mac supervise      # the launchd entry point, not run by hand
```

Manages a fully isolated Firecracker worker running inside a managed Linux guest VM on a Mac, using nested virtualization through Apple's Virtualization.framework. Requires Apple silicon M3 or newer running macOS 15 or newer: nested virtualization isn't exposed on older Apple silicon or on Intel, and there is no process-provider fallback or degraded mode, so `brevi mac install` refuses on an unsupported Mac and exits non-zero without leaving anything behind. See [macOS workers](/guides/macos-worker/) for the full guide.

### `brevi mac install`

Requires [Lima](https://lima-vm.io/) (`brew install lima`), offering to install it when missing. Runs the hardware preflight, ensures Lima is present, saves settings to `~/.brevi/mac-vm.json` (mode `0600`; deliberately separate from `~/.brevi/config.json`), renders a pinned Lima template to `~/.brevi/mac/lima-brevi.yaml`, creates and first-boots the VM, and installs a launchd agent at `~/Library/LaunchAgents/dev.brevi.macvm.plist` that runs `brevi mac supervise` at login and keeps it alive across restarts.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--host <url>` | `http://localhost:<port>` of whichever local listener the guest can reach | The brevi host the guest worker dials |
| `--token <token>` | none | Single-use pairing token minted on the host's Workers page; not needed once the guest is enrolled with that same host |
| `--cpus <n>` | 4 | VM CPU count |
| `--memory <gib>` | 8 | VM memory, in GiB |
| `--disk <gib>` | 100 | VM disk size, in GiB |
| `--idle-stop <minutes>` | 20 | Minutes idle (no leased run, no attach session, no queued host work) before the VM stops; `0` disables the idle stop |
| `--concurrency <n>` | 1 | Dispatched runs the guest worker executes at once |
| `--name <name>` | this machine's hostname | Shown for this worker on the host's dashboard |
| `-y, --yes` | | Answer every prompt with its default and never wait for input |

When `--host` is omitted, the port comes from whichever of this machine's listeners the guest can actually dial: the `fleet.host` worker channel when it is bound, otherwise the dashboard's `server.host`. Install refuses when both are loopback-only, since nothing the guest sends could reach them. The guest's own copy of the URL has a loopback host rewritten to `host.lima.internal` (inside the VM, `localhost` is the VM), while the macOS-side supervisor keeps polling the host on `localhost`.

The guest is a pinned Ubuntu 24.04 cloud image (sha256-verified) with no host mounts, provisioned on first boot with Node.js, `@brevi/cli`, the ordinary `brevi setup --yes` Firecracker provisioning (binary, kernel, prebuilt rootfs, tap networking), a `brevi-network` oneshot unit that reapplies tap devices, forwarding and NAT on every boot (none of which survives a restart, and the supervisor restarts this VM on every idle cycle), and a `brevi-worker` systemd unit running `brevi worker` as root, which `Requires=` the networking unit. The guest worker reports its os as `macos-vm`, which the dashboard's Workers page shows as **macOS VM**.

### `brevi mac status`

Reports the VM's state and whether its `brevi-network` and `brevi-worker` units are active in the guest.

### `brevi mac start` / `brevi mac stop`

Starts or stops the VM immediately, bypassing the idle-stop policy.

### `brevi mac uninstall`

```
brevi mac uninstall [-y, --yes]
```

Removes the launchd agent, the VM and its disk, the rendered Lima template, `~/.brevi/mac-vm.json`, and the supervisor log.

### `brevi mac supervise`

The launchd agent's entry point, installed and run automatically by `brevi mac install`; not meant to be run by hand. Polls the host's [`GET /api/worker/demand`](/reference/api/#worker-demand), authenticating as the guest's own worker, and starts or stops the VM according to the idle-stop policy. A drained worker is never woken for queued work, since the scheduler would not dispatch to it, logging to `~/.brevi/logs/mac-vm.log`.

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
