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
  on `PATH`, in `~/.brevi/bin`, or at the configured `binary`, the kernel and ssh key
  present, and a rootfs resolvable, from `sandbox.firecracker.rootfs` if it's a custom
  path, otherwise a from-source build at the default path or, failing that, the versioned
  download cache. Otherwise the process provider. `auto` never fails; it downgrades.
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

The recommended path is the first `brevi` (or `npx @brevi/cli`) on a Linux host: it
installs missing host tools (offered via apt), checks KVM access, downloads the
firecracker binary and kernel (sha256-verified against pinned digests), fetches the
rootfs, and sets up networking, idempotently, printing every sudo command before
running it. Its final check also verifies networking (tap devices and IPv4 forwarding).
The worker installer and `brevi mac install` call the same flow unattended
(`brevi setup --yes`). The steps below are the manual equivalent.

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

The recommended path needs no local build: first launch (or automatically at `brevi
start`, once the other gates above pass) downloads the prebuilt, checksum-verified image
published for the running `@brevi/cli` release and caches it, so most hosts never run
Docker at all. See "Prebuilt images" below.

To build from source instead, for development or an air-gapped host:

```sh
sudo packages/sandbox/scripts/build-rootfs.sh --with-kernel
```

Builds a ~2 GB ext4 image at `~/.brevi/images/rootfs.ext4` containing node 22, git, curl,
tar, ripgrep, both agent CLIs (`@anthropic-ai/claude-code` and `@openai/codex`), `ccusage`
(used by the orchestrator for live cost capture from the Claude Code transcripts), and an
sshd. Needs docker and root. The image no longer depends on a baked-in key (from-source
builds still bake the local one as a fallback): brevi passes the host's public key at boot
via the `brevi.authorized_keys` kernel argument, and the guest installs it before starting
sshd, so one image works on any machine. The key itself,
`~/.brevi/images/id_ed25519`, is generated on demand (on first launch, or automatically the
first time it's needed) if missing, independent of the rootfs image.

### 3. Networking

```sh
sudo packages/sandbox/scripts/setup-network.sh --taps 16 --user "$(whoami)"
```

Enables `ip_forward`, installs an iptables MASQUERADE rule for `172.30.0.0/16`, and
pre-creates a pool of tap devices owned by your user so brevi can attach VMs to them
without root. One tap is consumed per concurrent run, so provision at least
`sandbox.concurrency` of them; 16 covers the maximum. brevi never escalates privileges itself: if it has to create a tap device
and gets `EPERM`, it fails with a message pointing back at this script. Both the rules and
the devices are lost on reboot, so re-run after restarting; a re-run converges on the
pool you ask for, deleting taps beyond `--taps` and re-pointing the NAT rules when the
egress interface has changed. Every firewall rule it installs carries
`-m comment --comment brevi-network`, and cleanup deletes only rules carrying that tag
(or matching, character for character, one of the three shapes an older brevi wrote), so
your own rules about the same subnet or tap devices are left alone. `--clean` removes
everything the script created, whatever interface the rules name, and puts
`net.ipv4.ip_forward` back to the value the first run found (recorded in
`/var/lib/brevi-network.state`).

### 4. KVM access

`/dev/kvm` must be readable and writable by the user running brevi:

```sh
sudo usermod -aG kvm "$(whoami)"   # log out and back in
```

## Prebuilt images

Published in lockstep with each `@brevi/cli` release, at
`https://images.brevi.dev/rootfs/<cli release>/<arch>/`, one `manifest.json` and one
`rootfs.ext4.gz` per release and architecture (`x86_64`, `aarch64`); the manifest also
carries the rootfs contract version (`ROOTFS_VERSION`), used for the compatibility
handshake below. The base URL is `sandbox.firecracker.rootfsBaseUrl`, overridable for a
self-hosted mirror. Downloads verify sha256 of both the compressed and decompressed image
before an atomic rename into `~/.brevi/cache/rootfs/<cli release>/rootfs.ext4`; the cached
image is re-verified against its recorded digest at startup and again each time a sandbox
is created, with a corrupted cache triggering an automatic redownload rather than a boot
failure. Concurrent installs (two brevi processes) are serialized by a per-version lock
file with per-installer staging directories, so an install can never corrupt another one in
progress. After an install, cached entries unused for 30 days are pruned; an entry still in
use is never pruned, so two installed brevi versions keep separate cached images without
conflict. A custom `sandbox.firecracker.rootfs` path is always used as-is and never
downloaded over; the default path also wins when a valid from-source image already lives
there.

## Troubleshooting

- **`firecracker exited before opening its API socket`**: read
  `~/.brevi/workspaces/<id>/firecracker.log`; it holds the guest console.
- **`microVM did not accept ssh within 30000ms`**: the same log shows whether the kernel
  panicked, the rootfs failed to mount, or sshd never started. A missing `ip=` route
  usually means the tap device has no address (re-run the network script).
- **Guest has no DNS/egress**: check the MASQUERADE rule and `net.ipv4.ip_forward`; the
  image ships `/etc/resolv.conf` pointing at 1.1.1.1.
