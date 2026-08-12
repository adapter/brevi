---
title: macOS workers
description: Run a fully isolated Firecracker worker on a Mac by managing a Linux guest VM with nested virtualization, and the hardware it requires.
---

Firecracker needs KVM, a Linux kernel feature with no macOS port, so a Mac normally falls back to the unisolated [process provider](/guides/sandboxes/#the-process-provider). On Apple silicon M3 or newer, running macOS 15 or newer, Apple's Virtualization.framework exposes nested virtualization: a managed Linux guest VM sees KVM inside it, and the stock Firecracker sandbox provider runs there unchanged. `brevi mac` manages that guest for you, turning such a Mac into a first-class, isolated worker.

## Hardware requirement

Nested virtualization on Apple silicon is gated by Apple to **M3 or newer, on macOS 15 or newer**. Older Apple silicon (M1, M2) and every Intel Mac are not supported as workers: there is no process-provider fallback and no degraded mode. `brevi mac install` runs a hardware preflight before touching anything and refuses with the concrete unmet requirement, exiting non-zero without leaving anything behind, when the Mac doesn't qualify.

On an unsupported Mac, run brevi as a scheduling host that dispatches to a Linux worker, or run the worker itself on a Linux machine. See [Sandboxes](/guides/sandboxes/) for the process provider and [`brevi worker`](/reference/cli/#brevi-worker) for joining a fleet from Linux.

## What runs where

The worker daemon (`brevi worker`) runs entirely inside the guest VM and dials the host directly, exactly like any other Linux worker; the guest has its own Firecracker install and boots its own microVMs for runs. macOS's only job is supervising the VM's lifecycle: starting it, stopping it when idle, and keeping the launchd agent alive. To the host the worker is indistinguishable from one on bare Linux, except it reports its os as `macos-vm`, which the dashboard's Workers page shows as **macOS VM** next to the worker.

## Install

```sh
brevi mac install [--host <url>] [--token <token>] [--cpus <n>] [--memory <gib>] [--disk <gib>]
                  [--idle-stop <minutes>] [--concurrency <n>] [--name <name>] [-y, --yes]
```

Requires [Lima](https://lima-vm.io/) (`brew install lima`); install offers to run that for you when it's missing.

Install, in order: runs the hardware preflight, ensures Lima is present, saves settings to `~/.brevi/mac-vm.json` (mode `0600`, since it holds the guest's enrollment secrets; kept separate from `~/.brevi/config.json`, the schema the dashboard's settings forms mirror), renders a pinned Lima template to `~/.brevi/mac/lima-brevi.yaml`, creates and first-boots the VM, and installs a launchd agent at `~/Library/LaunchAgents/dev.brevi.macvm.plist` that runs `brevi mac supervise` at login and keeps it alive across restarts. The supervisor's log is `~/.brevi/logs/mac-vm.log`. A second `brevi mac install` stands the running supervisor down for the duration, so it cannot idle-stop the VM midway through reprovisioning it, and reinstalls it afterwards. If the CLI is running from npm's disposable `npx` cache, its bundle is copied to `~/.brevi/mac/cli` and the launchd agent points there: a `KeepAlive` agent aimed at a cache npm later clears would fail to start forever, leaving a stopped VM with nothing to wake it.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--host <url>` | `http://localhost:<port>` of whichever local listener the guest can reach | The brevi host the guest worker dials |
| `--token <token>` | none | Single-use pairing token minted on the host's Workers page; not needed once the guest is enrolled |
| `--cpus <n>` | 4 | VM CPU count |
| `--memory <gib>` | 8 | VM memory, in GiB |
| `--disk <gib>` | 100 | VM disk size, in GiB |
| `--idle-stop <minutes>` | 20 | Minutes idle before the VM stops; `0` disables the idle stop |
| `--concurrency <n>` | 1 | Dispatched runs the guest worker executes at once |
| `--name <name>` | this machine's hostname | Shown for this worker on the host's dashboard |
| `-y, --yes` | | Answer every prompt with its default and never wait for input |

The `--host` default is what you want when the Mac is also the host; to join another machine's fleet, point it at that machine's brevi.

One detail matters when the Mac is the host: the guest VM is a separate machine on Lima's own network, so `localhost` inside it is the guest, not the Mac. The URL you see on the macOS side (what the supervisor polls) stays a `localhost` one, and the guest's copy is rewritten to `host.lima.internal`, the name Lima resolves back to the Mac. That address only answers if the orchestrator listens on more than loopback, which it does not by default: set the worker channel's bind address to `0.0.0.0` (`fleet.host`, on Configuration > Workers) before installing. `brevi mac install` checks this up front and refuses, without provisioning anything, when both listeners are loopback-only, rather than leaving you with a guest worker that can never enroll. When it does have a choice it prefers the `fleet.host` listener over the dashboard's, since that listener carries only the authenticated worker channel. `--token` has no default, because a pairing token is minted on demand: open Configuration > Workers on the host, use "Add a worker", and pass the token it prints. It is single-use, and the guest trades it once for a durable credential of its own, so a later `brevi mac install` against the same host needs no token at all. Pointing the VM at a *different* orchestrator does: a credential only works with the host that issued it, so install refuses without a fresh `--token` rather than provisioning a guest that could never enroll.

The guest itself is a pinned Ubuntu 24.04 cloud image, verified against a sha256 digest, with no host mounts at all. First boot provisions it like any other brevi Linux host: Node.js, `@brevi/cli`, the ordinary `brevi setup --yes` Firecracker provisioning (binary, kernel, prebuilt rootfs, tap networking), and a `brevi-worker` systemd unit that runs `brevi worker` as root, so the guest keeps working across reboots without the supervisor's help.

One piece of that provisioning does not survive a reboot, and this VM reboots on every idle cycle: tap devices, IPv4 forwarding and the NAT and FORWARD rules are runtime state that a restart drops. A second unit, `brevi-network`, reapplies them on every boot before the worker starts, so a VM that has been stopped and restarted still gives its microVMs egress. The worker unit `Requires=` it: if the networking cannot be applied, this machine stays offline rather than accepting runs that would fail on their first clone. `brevi mac status` reports both units separately for that reason.

## Resource and idle behaviour

`--cpus`, `--memory`, `--disk` are fixed when the VM is created: Lima owns an existing instance's sizing, so changing them means `brevi mac uninstall` followed by a fresh install. Re-running `brevi mac install` on an existing VM reuses it and re-applies the guest side, which is how `--host`, `--token`, `--name` and `--concurrency` are changed. Stopping is made atomic with dispatch rather than racing it: before cutting the power the supervisor drains this worker on the host, which stops the scheduler placing runs on it, and only stops the VM if that same reply shows nothing still in flight. A run that lands during the reservation cancels the shutdown, and the worker goes back into rotation. The VM stops itself after `--idle-stop` minutes with no leased run, no attach session, and no queued work the host could give it, and cold-starts on its own the next time the host has a run queued for it: the supervisor polls the host's [`GET /api/worker/demand`](/reference/api/#worker-demand), authenticating as the guest's own worker with a copy of its credential, and boots the VM when it sees queued work. The host retries dispatch while the VM boots, so a run queued against a sleeping Mac just takes its boot time before it starts.

Draining this worker (Configuration > Workers on the host) takes it out of that loop entirely: the scheduler stops dispatching to a drained worker, so the supervisor stops treating the host's queue as a reason to be awake. A drained VM finishes whatever it already holds, then idle-stops and stays stopped, however long the queue gets, until it is enabled again.

## Day-to-day commands

```sh
brevi mac status       # VM state, whether the worker is registered
brevi mac start        # start the VM now, bypassing idle-stop
brevi mac stop         # stop the VM now
brevi mac uninstall [-y, --yes]
```

`brevi mac supervise` is the launchd agent's entry point (installed automatically); it isn't meant to be run by hand.

Logs live at `~/.brevi/logs/mac-vm.log`.

## Uninstall

```sh
brevi mac uninstall [-y, --yes]
```

Removes the launchd agent, the VM and its disk, the rendered Lima template, `~/.brevi/mac-vm.json`, and the supervisor log.
