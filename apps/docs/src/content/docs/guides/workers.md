---
title: Workers
description: Add a Linux machine to the fleet with the one-line installer, what it sets up, and how to check on, update, and remove it.
---

A **worker** is a machine that executes runs. The host (wherever `brevi` runs) is a pure scheduler: it polls Linear, holds the run store, and opens PRs, but never touches a sandbox itself. Every run's sandbox, Firecracker microVM or process, lives on whichever worker executed it. Add workers when you want runs to execute somewhere other than the machine running the dashboard: a beefier Linux box with KVM, or several machines sharing the load.

## The local worker

A single-machine setup needs none of the enrollment below. When the host itself can execute runs (Linux), it spawns and supervises a worker of its own on startup: the same `brevi worker` daemon, connected over loopback, with a credential the host mints and injects itself, no pairing token involved. It reads the same `sandbox.*` config (provider, concurrency, VM size) that has always governed execution on that machine, so a fresh `npx @brevi/cli` on Linux behaves exactly as it always has, and `brevi stop` stops the worker and its sandboxes along with the orchestrator. It appears on the Workers page as **This machine**: you can drain it to keep runs off the host, but not rename or revoke it. If it crashes, the host restarts it with backoff; its logs land in `~/.brevi/logs/local-worker.log`.

On a Mac without the [managed worker VM](/guides/macos-worker/), the host cannot execute runs itself: labeled tickets queue instead of failing, and Mission Control says so and points at enrolling a worker (below) or setting up the macOS worker.

## Installing a worker

On a Linux machine with KVM and systemd, run the one-liner as root:

```sh
curl -fsSL https://brevi.dev/install.sh | sudo sh -s -- --host https://your-host:4400 --token <pairing token>
```

`--host` is the URL of the brevi host to connect to. `--token` is a pairing token: mint one on that host under Configuration > Workers (`/config/workers`) with "Add a worker". It is single-use, expires 15 minutes after minting, and enrolling is all it does: the worker redeems it once for a durable per-worker credential and never needs a token again. Re-running the installer on an enrolled machine needs no `--token` at all; pass a fresh one only to enroll again after the worker was revoked.

The host has to be reachable from the worker. brevi binds `127.0.0.1` by default, which keeps the dashboard local; a remote worker needs `server.host` set to `0.0.0.0` on the host instead. **The dashboard and API have no authentication**, so setting `0.0.0.0` exposes full control of brevi, including a shell into its sandboxes, to anything that can reach the port. Only do this on a network you trust.

Other install flags: `--name` (defaults to the machine's hostname), `--concurrency` (how many runs it executes at once, 1 to 16, the same limit `sandbox.concurrency` carries), `--taps` (how many tap devices to pre-provision for Firecracker networking; 16 is both the default and the minimum, and it is raised to match `--concurrency`), `--version` (pin a specific `@brevi/cli` release instead of the latest), and `--binary <path>` to install from a local file instead of downloading one.

If `--host` is omitted the installer asks for it before it checks anything, since egress to that host is part of the preflight and there is no point provisioning a machine that cannot reach it.

## What it installs

| Path | Contents |
| --- | --- |
| `/usr/local/bin/brevi` | The standalone `brevi` executable (no node/npm needed) |
| `/usr/local/lib/brevi/` | `setup-network.sh` and small wrapper scripts the systemd units call |
| `/etc/brevi/worker.env` | `BREVI_HOST`, `BREVI_WORKER_NAME`, `BREVI_CONCURRENCY`, and `BREVI_TOKEN` until enrollment completes |
| `/etc/brevi/network.env` | `BREVI_TAPS`, and nothing else: the network unit runs as root, so it is handed only the number it needs |
| `/etc/brevi/ownership.env` | Whether this installer created the `brevi` user and group, so an uninstall removes only what it made |
| `/var/lib/brevi` | Home directory of the `brevi` system user; holds `~/.brevi/config.json`, the `~/.brevi/worker.json` enrollment record, and everything else brevi manages |

The pairing token is the only secret that ever reaches `/etc/brevi/worker.env` (mode `0640`, `root:brevi`), and only until it has been spent: the daemon redeems it on its first connection for the durable credential in `/var/lib/brevi/.brevi/worker.json` (mode `0600`), and the installer deletes the `BREVI_TOKEN` line as soon as the host confirms that worker connected. Every later start, including after a reboot, carries no token at all.

Both units read their settings from those env files through systemd's `EnvironmentFile=`, which parses them as data, and exec a small wrapper that assembles the real command from the environment. Nothing sources them as shell, so a worker name with a space in it is a name, not a command.

Two systemd units are installed and enabled:

- **`brevi-network.service`**: a oneshot that recreates the tap device pool and NAT rules at every boot (see [Sandboxes](/guides/sandboxes/) for what that setup does and why it isn't persistent on its own).
- **`brevi-worker.service`**: the worker daemon. Restarts on failure, logs to journald, and runs as the `brevi` user with only the `/dev/kvm` group added, nothing else.

Before starting the service, the installer provisions the Firecracker binary (the version brevi pins, installed over anything else it finds at a different version), the kernel, and the prebuilt rootfs (`brevi setup --yes --skip-network --set-provider`, networking having already been handled by the systemd unit above, and `--set-provider` putting `sandbox.provider` on `firecracker` in the service user's config so the worker sandboxes what it executes). It finishes by restarting both units and waiting for the daemon's own "registered with `<host>`" line to appear in `journalctl -u brevi-worker`, counting only what the restarted process logged, so a re-run can't report success on the strength of the old process still being connected. The confirmation is deliberately the worker's account rather than a question put to the host: when the host has a [worker channel listener](/reference/configuration/#fleet) of its own, the address in the pairing command is that listener, and it serves the authenticated worker channel and nothing else.

## Preflight only

```sh
curl -fsSL https://brevi.dev/install.sh | sudo sh -s -- --check --host https://your-host:4400
```

`--check` runs only the preflight, no writes: KVM, cgroup v2, systemd, the required tools, disk space, and egress to the host you'd be pairing with. It exits non-zero when something is missing, so it's safe to run before committing to an install, or in a script that gates on it. Pass `--host` (it prompts for one otherwise, and a previous install's is reused), since egress to the pairing host is one of the checks. That check asks whether the port answers at all, not whether it serves a dashboard: a host with `fleet.host` set gives out its worker channel listener's address, and that listener answers everything except the worker channel with a 404, by design. Egress to the artifact hosts is checked the same way whatever `--binary` says, since the rootfs image (and, on an unprovisioned machine, firecracker and its guest kernel) is downloaded during the install regardless of where the worker binary came from.

The cgroup check does more than look for a cgroup v2 mount: it has systemd start a throwaway transient unit carrying the same restrictions `brevi-worker.service` uses, and once the service user exists that unit also runs as `brevi` and opens `/dev/kvm`. A hierarchy that is read-only or not delegated (common inside containers) fails here, with systemd's own message, instead of at the first boot.

## Updating

```sh
sudo brevi worker update
```

Upgrades the installed binary and its prebuilt rootfs in place, without losing enrollment, and restarts `brevi-worker.service` if it's running. Run as root on a machine with the service installed, it works against the `brevi` user's own `~/.brevi` (config, image cache), not root's, so the daemon actually finds what was just downloaded; a failed restart is a failed update and exits non-zero. Re-running the installer does the same thing: it's idempotent, and the pairing and the worker's id both survive.

## Uninstalling

```sh
curl -fsSL https://brevi.dev/install.sh | sudo sh -s -- --uninstall
```

Reverses everything: stops and removes both systemd units, tears down the network config (tap devices, the iptables rules brevi tagged as its own whatever interface they name, `/etc/sysctl.d/99-brevi.conf`, and the `net.ipv4.ip_forward` value restored to what the install found), clears cached images, and removes the binary. Anything it could not remove is reported and exits non-zero rather than being summarised as a clean removal.

The `brevi` system user goes too, but only when the installer is the one that created it: the install records that in `/etc/brevi/ownership.env`, and an account that was already on the machine is left alone (with its home kept, minus brevi's own `~/.brevi` directory) and reported, rather than deleted by an uninstall that has no way to know what else it is used for.

## Operating it

```sh
systemctl status brevi-worker
journalctl -u brevi-worker -f
```

The worker reconnects on its own, with exponential backoff, whenever the connection to the host drops, including after a reboot, no manual intervention needed.

## Manual install

Machines without systemd (macOS, or a Linux box you'd rather not hand a service to) can still join the fleet: run `npx @brevi/cli worker --host <url> --token <token>` directly, in the foreground or under your own process manager. There's no installer needed, just the CLI and network access to the host. For the from-source Firecracker setup path (building the rootfs with Docker, provisioning networking by hand), see [Sandboxes](/guides/sandboxes/).
