# @brevi/sandbox

The execution environment brevi runs coding agents in. One `Sandbox` holds one run's
workspace; the orchestrator creates it, pushes a checkout in, execs the agent, pulls
artifacts out, and destroys it.

Two providers implement the same interface:

| provider      | isolation                   | where it runs                     |
| ------------- | --------------------------- | --------------------------------- |
| `firecracker` | separate kernel, own rootfs | Linux with KVM                     |
| `process`     | none (a plain directory)    | anywhere, including macOS          |

## Interface

```ts
const provider = await createSandboxProvider({ requested: "auto", firecracker });
const sandbox = await provider.create({ id: runId, env: { ANTHROPIC_API_KEY } });

await sandbox.pushDirectory(localCheckout, ".");
const result = await sandbox.exec("claude", ["-p", prompt], { onStdout: log });
await sandbox.pullDirectory("artifacts", localArtifacts);
await sandbox.destroy();
```

`exec` never throws on a non-zero exit; inspect `result.exitCode`. Output is streamed to
`onStdout`/`onStderr` as it arrives and the last ~2 MB of each stream is also returned in
the result. Timeouts kill the command and report exit code `124`. Relative `cwd` and
relative paths given to `pushDirectory`/`writeFile`/… resolve against `workspacePath`.

## Provider selection

`createSandboxProvider` maps `sandbox.provider` from the brevi config:

- `"auto"` selects Firecracker when the full preflight passes (the same checks
  `ensureAvailable()` runs): Linux, `/dev/kvm` readable and writable, the binary resolving
  on `PATH`, in `~/.brevi/bin`, or at the configured `binary`, and the kernel, rootfs, and
  ssh key present. Otherwise the process provider. `auto` never fails; it downgrades.
- `"firecracker"` / `"process"`: constructed and `ensureAvailable()`d immediately, so a
  misconfigured host fails at startup with one aggregated, actionable error rather than
  mid-run.

### macOS

Firecracker requires KVM, which is a Linux kernel feature; there is no macOS port and
Apple's Hypervisor.framework is not a substitute. On macOS `auto` therefore always selects
the process provider, which runs agent commands directly on your machine under
`~/.brevi/workspaces/<run-id>/workspace`. That is fine for development but provides **no
isolation**: an agent can read and write anything your user can. For real isolation run
brevi on a Linux host, or inside a Linux VM with nested virtualisation enabled.

## Architecture

```
select.ts                 provider selection
process/provider.ts       ProcessProvider  -> execa in ~/.brevi/workspaces/<id>/workspace
firecracker/
  provider.ts             host preflight, boot + ssh wiring
  vm.ts                   microVM lifecycle (rootfs copy, firecracker process, API config)
  api.ts                  Firecracker HTTP API over its unix socket (undici)
  network.ts              tap device + /30 subnet allocation
  ssh.ts                  ssh argv, shell quoting, wait-for-boot
  sandbox.ts              Sandbox implementation on top of ssh/tar
exec.ts                   shared streaming/capturing command runner
```

### How a microVM boots

1. `~/.brevi/workspaces/<id>/` is created and the base rootfs is cloned into it with
   `cp --reflink=auto` (copy-on-write on btrfs/XFS, a plain copy elsewhere), so each run
   gets a writable disk without mutating the image.
2. A tap device `brevi-tap<N>` is allocated. Each VM gets its own /30 out of
   `172.30.0.0/16` (`…N.1` host, `…N.2` guest), so guests cannot see each other.
3. `firecracker --api-sock …` is started with its console redirected to
   `firecracker.log` in the sandbox directory.
4. The VM is configured over the API socket: machine config, boot source, root drive,
   network interface, then `InstanceStart`. Boot args are
   `console=ttyS0 reboot=k panic=1 pci=off ip=<guest>::<host>:<netmask>::eth0:off`.
5. The provider polls `ssh true` with backoff for up to 30 s. Boot is typically ~1 s.

Everything after boot goes over ssh as `root@<guest-ip>` using
`~/.brevi/images/id_ed25519`: `exec` runs one `cd <cwd> && exec env … <cmd>` command,
directory transfers stream through `tar`, and `writeFile`/`readFile` use `cat`. The
workspace inside the guest is `/workspace`.

`destroy()` SIGTERMs firecracker, SIGKILLs it after a 3 s grace period, deletes the tap
device (only if brevi created it; pooled devices from the setup script are left in
place), and removes the sandbox directory.

## One-time Linux setup

The recommended path is `brevi setup`: it installs missing host tools (offered via apt),
checks KVM access, downloads the
firecracker binary and kernel (sha256-verified against pinned digests), builds the rootfs,
and sets up networking, interactively and idempotently, printing every sudo command before
running it. Its final check also verifies networking (tap devices and IPv4 forwarding),
and it exits non-zero when the host is not ready. The steps below are the manual
equivalent.

### 1. Kernel

Firecracker boots an uncompressed `vmlinux`. The easiest source is the Firecracker CI
bucket used by their quickstart:

```sh
mkdir -p ~/.brevi/images
curl -fsSL -o ~/.brevi/images/vmlinux \
  https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.10/x86_64/vmlinux-6.1.102
```

Any kernel works provided virtio-blk, virtio-net, ext4 and the 8250 serial driver are
built in (not modules). `CONFIG_IP_PNP` is nice to have but not required, because the guest
init also parses the `ip=` argument itself.

### 2. Rootfs

```sh
sudo packages/sandbox/scripts/build-rootfs.sh --with-kernel
```

Builds a ~2 GB ext4 image at `~/.brevi/images/rootfs.ext4` containing node 22, git, curl,
tar, ripgrep, both agent CLIs (`@anthropic-ai/claude-code` and `@openai/codex`), `ccusage`
(used by the orchestrator for live cost capture from the Claude Code transcripts), and an
sshd whose `authorized_keys` holds the public half of `~/.brevi/images/id_ed25519`
(generated on first run). Needs docker and root. Regenerating the key means rebuilding the
image.

### 3. Networking

```sh
sudo packages/sandbox/scripts/setup-network.sh --taps 16 --user "$(whoami)"
```

Enables `ip_forward`, installs an iptables MASQUERADE rule for `172.30.0.0/16`, and
pre-creates a pool of tap devices owned by your user so brevi can attach VMs to them
without root. One tap is consumed per concurrent run, so provision at least
`sandbox.concurrency` of them; 16 covers the maximum. brevi never escalates privileges itself: if it has to create a tap device
and gets `EPERM`, it fails with a message pointing back at this script. Both the rules and
the devices are lost on reboot, so re-run after restarting. `--clean` removes them.

### 4. KVM access

`/dev/kvm` must be readable and writable by the user running brevi:

```sh
sudo usermod -aG kvm "$(whoami)"   # log out and back in
```

## Troubleshooting

- **`firecracker exited before opening its API socket`**: read
  `~/.brevi/workspaces/<id>/firecracker.log`; it holds the guest console.
- **`microVM did not accept ssh within 30000ms`**: the same log shows whether the kernel
  panicked, the rootfs failed to mount, or sshd never started. A missing `ip=` route
  usually means the tap device has no address (re-run the network script).
- **Guest has no DNS/egress**: check the MASQUERADE rule and `net.ipv4.ip_forward`; the
  image ships `/etc/resolv.conf` pointing at 1.1.1.1.
