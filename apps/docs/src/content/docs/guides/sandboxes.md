---
title: Sandboxes
description: How brevi isolates each run with bubblewrap on Linux.
---

Every run executes inside a [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`) sandbox on a Linux worker, with its own network namespace connected through [pasta](https://passt.top/) (the `passt` package). There is no provider switch and no process fallback.

| isolation | where it runs |
| --------- | ------------- |
| Linux namespaces (user, mount, pid, ipc, uts, net) | Linux with `bwrap` and `pasta` on `PATH` |

A machine that cannot run bwrap (macOS, or Linux without bubblewrap and passt) is a scheduler only. Labeled tickets queue until a Linux worker with bwrap is online.

## What the sandbox can see

Each command runs under `bwrap` with a private `/tmp`, `/dev/shm`, `/proc`, and `/dev`, a read-only bind of host binaries (`/usr`, `/bin`, `/lib`, `/etc`) plus any extra `PATH` directories that are not already covered (so a user-local `claude` under `~/.local/bin` or nvm is visible without binding `$HOME`), and a read-write bind of the per-run directory (`~/.brevi/workspaces/<id>/`). The operator's `$HOME` is not bound, so the agent cannot read other checkouts or host secrets. The inner process gets a cleared environment: `HOME` is `~/.brevi/workspaces/<id>/home`, beside the checkout, never the checkout itself.

## Networking

The sandbox has outbound internet access, but not the host's network identity. pasta gives each command a private network namespace with user-mode networking: git, npm, and model APIs work, while the host's loopback interface does not exist inside the sandbox. An agent cannot reach services bound to the host's `127.0.0.1` (the orchestrator dashboard and API among them), no sandbox port is published on the host, and the gateway address does not lead back to host services. DNS always works, whatever the host's resolver setup: queries are forwarded to the host's resolver through pasta.

Agent CLIs (`claude`, `codex`, `gh`, `wrangler`) come from the worker host's `PATH`. The wrap also binds the CLI's package tree (the `lib/` next to a `bin/` prefix, and any `node_modules` ancestor) so an npm-installed Codex launcher can see its sibling modules.

## Setup

On Linux, `brevi setup` installs bubblewrap and passt when they are missing (`apt install bubblewrap passt`) and checks that unprivileged user namespaces work. `brevi doctor` reports the same.

```sh
brevi setup
```

The [Linux worker installer](/guides/workers/) installs bubblewrap and passt as root (`apt-get install bubblewrap passt`), installs the Claude and Codex CLIs globally, and probes user namespaces (both bwrap and pasta) as the `brevi` service user.

## Workers

Every run executes on a `brevi worker` daemon. On Linux, `brevi start` also supervises a local worker on this machine. Add more workers from the Workers page; each one is a bwrap worker.

```sh
curl -fsSL https://brevi.dev/install.sh | sudo sh -s -- \
  --host https://your-host:4400 --token <pairing-token>
```
