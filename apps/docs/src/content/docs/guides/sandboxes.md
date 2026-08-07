---
title: Sandboxes
description: How brevi picks a sandbox provider, what the Firecracker microVM setup needs on Linux, and the caveats of the process provider.
---

Every run executes inside a sandbox: one sandbox holds one run's workspace. The orchestrator creates it, pushes the checkout in, runs the coding agent, pulls artifacts out, and destroys it. Two providers implement the same interface.

| Provider | Isolation | Where it runs |
| --- | --- | --- |
| `firecracker` | Separate kernel, own rootfs, own /30 network | Linux with KVM |
| `process` | None (a plain directory) | Anywhere, including macOS |

## Choosing a provider

`brevi init` writes your choice to `sandbox.provider`:

- **`auto`** (recommended): Firecracker when the host passes the full preflight, the same checks `brevi start` runs for an explicit `firecracker` provider: Linux, `/dev/kvm` readable and writable, the firecracker binary resolving on `PATH`, in `~/.brevi/bin`, or at `sandbox.firecracker.binary`, and the kernel, rootfs, and ssh key images in place. Otherwise the process provider. `auto` never fails; it downgrades.
- **`firecracker`** / **`process`**: constructed and checked at startup, so a misconfigured host fails immediately with one aggregated, actionable error instead of halfway through a run.

You can change the provider any time by editing `sandbox.provider` in `~/.brevi/config.json` (or re-running `brevi init`) and restarting brevi.

## Firecracker

On Linux with KVM, each run boots its own microVM: the base rootfs is cloned copy-on-write, a `brevi-tap<N>` device is allocated with a private /30 out of `172.30.0.0/16` so guests cannot see each other, and firecracker is started with its console captured to `firecracker.log`. Boot is typically about a second. Everything after boot goes over ssh as `root@<guest-ip>` using `~/.brevi/images/id_ed25519`; the workspace inside the guest is `/workspace`.

### One-time host setup

Four things are needed once per machine. The recommended path is one command:

```sh
brevi setup
```

It walks through everything below interactively (see [the CLI reference](/reference/cli/#brevi-setup)), skips whatever is already in place, and prints every `sudo` command before running it. Downloads are sha256-verified against pinned digests, the final check also verifies networking (tap devices and IPv4 forwarding), and setup exits non-zero when the host is not ready. The manual equivalents follow; this is a summary, see `packages/sandbox/README.md` in the repo for the full walkthrough and troubleshooting.

1. **Kernel**: an uncompressed `vmlinux` at `~/.brevi/images/vmlinux`. The Firecracker CI bucket used by their quickstart is the easiest source. Any kernel works if virtio-blk, virtio-net, ext4 and the 8250 serial driver are built in rather than modules.

2. **Rootfs**: build the image (needs docker and root):

   ```sh
   sudo packages/sandbox/scripts/build-rootfs.sh --with-kernel
   ```

   This produces a ~2 GB ext4 image at `~/.brevi/images/rootfs.ext4` with node 22, git, curl, tar, ripgrep, both agent CLIs (`@anthropic-ai/claude-code` and `@openai/codex`, the latter used for the adversarial review step), and an sshd trusting `~/.brevi/images/id_ed25519`.

3. **Networking**: pre-create tap devices and the NAT rule:

   ```sh
   sudo packages/sandbox/scripts/setup-network.sh --taps 16 --user "$(whoami)"
   ```

   Each concurrent run needs its own tap device, so provision at least as many taps as your `sandbox.concurrency` setting; 16 covers the maximum. brevi never escalates privileges itself: if it has to create a tap device and gets `EPERM`, it fails with a message pointing back at this script. The rules and devices are lost on reboot, so re-run it after restarting. `--clean` removes them.

4. **KVM access**: `/dev/kvm` must be readable and writable by the user running brevi:

   ```sh
   sudo usermod -aG kvm "$(whoami)"   # log out and back in
   ```

:::tip
If a run fails with `firecracker exited before opening its API socket` or `microVM did not accept ssh within 30000ms`, read `~/.brevi/workspaces/<run-id>/firecracker.log`; it holds the guest console and will show a kernel panic, a rootfs that failed to mount, or a tap device with no address.
:::

## The process provider

The process provider runs agent commands directly on your machine, in `~/.brevi/workspaces/<run-id>/workspace`. It exists so brevi is usable on macOS and on Linux hosts without KVM.

:::caution[No isolation]
The process provider provides **no isolation whatsoever**. The coding agent runs as your user and can read and write anything you can, and brevi runs agents with permission prompts disabled. Use it for development against repositories you trust, not for unattended work.
:::

Firecracker requires KVM, which is a Linux kernel feature. There is no macOS port, and Apple's Hypervisor.framework is not a substitute, so on macOS `auto` always selects the process provider. For real isolation, run brevi on a Linux host, or in a Linux VM with nested virtualisation enabled.

## Timeouts and cleanup

`sandbox.timeoutMinutes` (60 by default) is a hard wall-clock limit on the agent command; hitting it kills the command and fails the run. A cancelled run's sandbox is destroyed immediately, and its scratch directory under `~/.brevi/workspaces/` is removed. A completed or failed run's sandbox is kept instead, for interactive resume, see below. Artifacts have already been copied into `~/.brevi/runs/` by then either way, so they survive.

## Retention and resuming

When a run completes or fails, brevi doesn't tear its sandbox down: compute stops (the microVM shuts off; nothing uses memory or CPU) but the disk is kept, checkout, installed dependencies and credentials included, for `sandbox.retentionHours` (24 by default, `0` disables retention). The expiry is stored on the run, so it survives an orchestrator restart; a timer reaps disks once their window ends, and any leftovers are also cleaned up on startup and on `brevi stop`.

Resume a retained run from its detail page in the dashboard with the "Open terminal" button, which opens the session in an embedded web terminal (the sandbox boots server-side, so this works even when the orchestrator runs on another machine), or run `brevi attach <runId>` in your own terminal. Either way boots the sandbox back up from its retained disk and opens an interactive `claude --resume` session with the run's full history; detaching releases compute again while the disk keeps counting down. Resume works for completed and failed runs and is Claude-only for now. Once the window passes, the dashboard shows a disabled "Sandbox expired" button and the API answers `410`.
