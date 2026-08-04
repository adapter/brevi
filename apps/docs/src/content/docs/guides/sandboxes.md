---
title: Sandboxes
description: How brevi picks a sandbox provider, what the Firecracker microVM setup needs on Linux, and the caveats of the process provider.
---

Every run executes inside a sandbox: one sandbox holds one run's workspace. The orchestrator creates it, pushes the checkout in, runs the coding agent, pulls artifacts out, and destroys it. Two providers implement the same interface.

| Provider | Isolation | Where it runs |
| --- | --- | --- |
| `firecracker` | Separate kernel, own rootfs, own /30 network | Linux with KVM |
| `process` | None — a plain directory | Anywhere, including macOS |

## Choosing a provider

`brevi init` writes your choice to `sandbox.provider`:

- **`auto`** (recommended) — Firecracker when *all* of the following hold: the platform is Linux, `/dev/kvm` is readable and writable, and the firecracker binary resolves on `PATH` (or at `sandbox.firecracker.binary`). Otherwise the process provider. `auto` never fails; it downgrades.
- **`firecracker`** / **`process`** — constructed and checked at startup, so a misconfigured host fails immediately with one aggregated, actionable error instead of halfway through a run.

You can change the provider any time by editing `sandbox.provider` in `~/.brevi/config.json` (or re-running `brevi init`) and restarting brevi.

## Firecracker

On Linux with KVM, each run boots its own microVM: the base rootfs is cloned copy-on-write, a `brevi-tap<N>` device is allocated with a private /30 out of `172.30.0.0/16` so guests cannot see each other, and firecracker is started with its console captured to `firecracker.log`. Boot is typically about a second. Everything after boot goes over ssh as `root@<guest-ip>` using `~/.brevi/images/id_ed25519`; the workspace inside the guest is `/workspace`.

### One-time host setup

Four things are needed once per machine. This is a summary — see `packages/sandbox/README.md` in the repo for the full walkthrough and troubleshooting.

1. **Kernel** — an uncompressed `vmlinux` at `~/.brevi/images/vmlinux`. The Firecracker CI bucket used by their quickstart is the easiest source. Any kernel works if virtio-blk, virtio-net, ext4 and the 8250 serial driver are built in rather than modules.

2. **Rootfs** — build the image (needs docker and root):

   ```sh
   sudo packages/sandbox/scripts/build-rootfs.sh --with-kernel
   ```

   This produces a ~2 GB ext4 image at `~/.brevi/images/rootfs.ext4` with node 22, git, curl, tar, ripgrep, `@anthropic-ai/claude-code`, and an sshd trusting `~/.brevi/images/id_ed25519`.

3. **Networking** — pre-create tap devices and the NAT rule:

   ```sh
   sudo packages/sandbox/scripts/setup-network.sh --taps 8 --user "$(whoami)"
   ```

   brevi never escalates privileges itself: if it has to create a tap device and gets `EPERM`, it fails with a message pointing back at this script. The rules and devices are lost on reboot — re-run it after restarting. `--clean` removes them.

4. **KVM access** — `/dev/kvm` must be readable and writable by the user running brevi:

   ```sh
   sudo usermod -aG kvm "$(whoami)"   # log out and back in
   ```

:::tip
If a run fails with `firecracker exited before opening its API socket` or `microVM did not accept ssh within 30000ms`, read `~/.brevi/workspaces/<run-id>/firecracker.log` — it holds the guest console and will show a kernel panic, a rootfs that failed to mount, or a tap device with no address.
:::

## The process provider

The process provider runs agent commands directly on your machine, in `~/.brevi/workspaces/<run-id>/workspace`. It exists so brevi is usable on macOS and on Linux hosts without KVM.

:::caution[No isolation]
The process provider provides **no isolation whatsoever**. The coding agent runs as your user and can read and write anything you can — and brevi runs agents with permission prompts disabled. Use it for development against repositories you trust, not for unattended work.
:::

Firecracker requires KVM, which is a Linux kernel feature. There is no macOS port, and Apple's Hypervisor.framework is not a substitute, so on macOS `auto` always selects the process provider. For real isolation, run brevi on a Linux host, or in a Linux VM with nested virtualisation enabled.

## Timeouts and cleanup

`sandbox.timeoutMinutes` (60 by default) is a hard wall-clock limit on the agent command; hitting it kills the command and fails the run. Either way — success, failure, or cancellation — the sandbox is destroyed and the run's scratch directory under `~/.brevi/workspaces/` is removed. Artifacts have already been copied into `~/.brevi/runs/` by then, so they survive.
