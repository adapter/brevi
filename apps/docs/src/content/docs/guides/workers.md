---
title: Workers
description: Add a Linux machine to the fleet with the one-line installer, what it sets up, and how to check on, update, and remove it.
---

A **worker** is a machine that executes runs. The host (wherever `brevi` runs) is a scheduler: it polls Linear, holds the run store, and opens PRs. Every run's bwrap sandbox lives on whichever worker executed it. Add workers when you want more Linux capacity than the machine running the dashboard.

## The local worker

A single-machine setup needs none of the enrollment below. When the host itself can execute runs (Linux with bubblewrap), it spawns and supervises a worker of its own on startup: the same `brevi worker` daemon, connected over loopback, with a credential the host mints and injects itself, no pairing token involved. `brevi stop` stops the worker and its sandboxes along with the orchestrator. It appears on the Workers page as **This machine**: you can drain it to keep runs off the host, but not rename or revoke it. If it crashes, the host restarts it with backoff; its logs land in `~/.brevi/logs/local-worker.log`.

On a Mac, or Linux without bubblewrap, the host cannot execute runs itself: labeled tickets queue instead of failing, and Mission Control says so and points at enrolling a Linux worker (below).

## Installing a worker

On a Linux machine with systemd, run the one-liner as root:

```sh
curl -fsSL https://brevi.dev/install.sh | sudo sh -s -- --host https://your-host:4400 --token <pairing token>
```

`--host` is the URL of the brevi host to connect to. `--token` is a pairing token: mint one on that host under Configuration > Workers (`/config/workers`) with "Add a worker". It is single-use, expires 15 minutes after minting, and enrolling is all it does: the worker redeems it once for a durable per-worker credential and never needs a token again. Re-running the installer on an enrolled machine needs no `--token` at all; pass a fresh one only to enroll again after the worker was revoked.

The host has to be reachable from the worker. brevi binds `127.0.0.1` by default, which keeps the dashboard local; a remote worker needs `server.host` set to `0.0.0.0` on the host instead. **The dashboard and API have no authentication**, so setting `0.0.0.0` exposes full control of brevi, including a shell into its sandboxes, to anything that can reach the port. Only do this on a network you trust.

Other install flags: `--name` (defaults to the machine's hostname), `--concurrency` (how many runs it executes at once, 1 to 16, the same limit `sandbox.concurrency` carries), `--version` (pin a specific `@brevi/cli` release instead of the latest), and `--binary <path>` to install from a local file instead of downloading one.

If `--host` is omitted the installer asks for it before it checks anything, since egress to that host is part of the preflight and there is no point provisioning a machine that cannot reach it.

## What it installs

| Path | Contents |
| --- | --- |
| `/usr/local/bin/brevi` | The standalone `brevi` executable (no node/npm needed) |
| `/usr/local/lib/brevi/` | `worker-start.sh`, the wrapper `brevi-worker.service` execs |
| `/etc/brevi/worker.env` | `BREVI_HOST`, `BREVI_WORKER_NAME`, `BREVI_CONCURRENCY`, and `BREVI_TOKEN` until enrollment completes |
| `/etc/brevi/ownership.env` | Whether this installer created the `brevi` user and group, so an uninstall removes only what it made |
| `/var/lib/brevi` | Home directory of the `brevi` system user; holds `~/.brevi/config.json`, the `~/.brevi/worker.json` enrollment record, and everything else brevi manages |

The pairing token is the only secret that ever reaches `/etc/brevi/worker.env` (mode `0640`, `root:brevi`), and only until it has been spent: the daemon redeems it on its first connection for the durable credential in `/var/lib/brevi/.brevi/worker.json` (mode `0600`), and the installer deletes the `BREVI_TOKEN` line as soon as the host confirms that worker connected. Every later start, including after a reboot, carries no token at all.

The unit reads its settings from that env file through systemd's `EnvironmentFile=`, which parses it as data, and execs a small wrapper that assembles the real command from the environment. Nothing sources it as shell, so a worker name with a space in it is a name, not a command.

One systemd unit is installed and enabled:

- **`brevi-worker.service`**: the worker daemon. Restarts on failure, logs to journald, and runs as the `brevi` user. No extra groups and no added capabilities: bwrap uses unprivileged user namespaces.

Before starting the service, the installer installs bubblewrap as root (`apt-get install bubblewrap` when it is missing), installs the Claude and Codex CLIs globally (`npm install -g @anthropic-ai/claude-code @openai/codex`) so a fresh Ubuntu box can actually execute the default agent, and probes `bwrap --unshare-user --unshare-pid true` as the `brevi` user. The worker refuses to start if `agent.command` is not on `PATH`. It finishes by restarting the worker unit and waiting for the daemon's own "registered with `<host>`" line to appear in `journalctl -u brevi-worker`, counting only what the restarted process logged, so a re-run cannot report success on the strength of the old process still being connected. The confirmation is deliberately the worker's account rather than a question put to the host: when the host has a [worker channel listener](/reference/configuration/#fleet) of its own, the address in the pairing command is that listener, and it serves the authenticated worker channel and nothing else.

## Preflight only

```sh
curl -fsSL https://brevi.dev/install.sh | sudo sh -s -- --check --host https://your-host:4400
```

`--check` runs only the preflight, no writes: Linux, architecture, systemd, cgroup v2, the required tools, disk space, bubblewrap if already installed, and egress to the host you'd be pairing with (and to the npm registry and images host unless `--version` / `--binary` answers those). It exits non-zero when something is missing, so it's safe to run before committing to an install, or in a script that gates on it. Pass `--host` (it prompts for one otherwise, and a previous install's is reused), since egress to the pairing host is one of the checks. That check asks whether the port answers at all, not whether it serves a dashboard: a host with `fleet.host` set gives out its worker channel listener's address, and that listener answers everything except the worker channel with a 404, by design.

The cgroup check does more than look for a cgroup v2 mount: it has systemd start a throwaway transient unit carrying the same restrictions `brevi-worker.service` uses, and once the service user exists that unit also runs as `brevi`. A hierarchy that is read-only or not delegated (common inside containers) fails here, with systemd's own message, instead of at the first boot.

## Updating

```sh
sudo brevi worker update
```

Upgrades the installed binary in place, without losing enrollment, and restarts `brevi-worker.service` if it's running. Re-running the installer does the same thing: it's idempotent, and the pairing and the worker's id both survive.

## Uninstalling

```sh
curl -fsSL https://brevi.dev/install.sh | sudo sh -s -- --uninstall
```

Reverses everything: stops and removes `brevi-worker.service` (and a leftover `brevi-network.service` from an older install, if present), best-effort tears down leftover tap devices from that older install, and removes the binary. Anything it could not remove is reported and exits non-zero rather than being summarised as a clean removal.

The `brevi` system user goes too, but only when the installer is the one that created it: the install records that in `/etc/brevi/ownership.env`, and an account that was already on the machine is left alone (with its home kept, minus brevi's own `~/.brevi` directory) and reported, rather than deleted by an uninstall that has no way to know what else it is used for.

## Operating it

```sh
systemctl status brevi-worker
journalctl -u brevi-worker -f
```

The worker reconnects on its own, with exponential backoff, whenever the connection to the host drops, including after a reboot, no manual intervention needed.

## Manual install

Machines without systemd (or a Linux box you'd rather not hand a service to) can still join the fleet: run `npx @brevi/cli worker --host <url> --token <token>` directly, in the foreground or under your own process manager. There's no installer needed, just the CLI, bubblewrap, and network access to the host. A Mac can enroll this way too, but it cannot execute runs: only a Linux worker with bubblewrap can.
