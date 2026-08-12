/**
 * Renders the Lima instance template and the guest-side provisioning payload
 * as plain strings. Everything here is pure (no fs, no exec): the installer
 * (another agent's work) is the only thing that writes these to disk or
 * hands them to `limactl`, which keeps the YAML and shell generation testable
 * without a VM and without a `yaml` dependency (the templates are small and
 * fixed-shape enough that hand-written template literals stay readable).
 */

/** Pinned Ubuntu 24.04 cloud image the guest boots, with the digest Lima verifies it against. */
export const GUEST_IMAGE = {
  release: "release-20260801",
  location:
    "https://cloud-images.ubuntu.com/releases/noble/release-20260801/ubuntu-24.04-server-cloudimg-arm64.img",
  arch: "aarch64",
  digest: "sha256:aa6da05756e85ea6dde4836b841fecb10cfd1ba3bcea320189d9af945db70476",
} as const;

/** systemd unit the guest runs the worker daemon under. */
export const GUEST_SERVICE_NAME = "brevi-worker";

/**
 * systemd unit that reapplies the guest's microVM networking on every boot.
 *
 * `brevi setup` configures tap devices, IPv4 forwarding and the NAT/FORWARD
 * rules once, and none of it survives a reboot (setup-network.sh says so
 * itself). On an ordinary Linux worker that is a human's problem after a
 * restart; here the supervisor stops and starts this VM on its own, all day,
 * so "after a reboot" is the normal case rather than the exception. Without
 * this, the first idle-stop leaves a guest whose worker still comes up and
 * still accepts runs, but whose microVMs have no egress, and every run fails
 * on its first clone.
 */
export const GUEST_NETWORK_SERVICE_NAME = "brevi-network";

/** Where the provisioning payload drops the wrapper that unit runs. */
export const GUEST_NETWORK_SCRIPT_PATH = "/usr/local/sbin/brevi-guest-network";

/**
 * The name Lima resolves inside every guest, on every vmType, to the macOS
 * host running it. The guest has no other way back: it is on Lima's own
 * network, so the host's LAN address may not be routable from it either.
 */
export const LIMA_HOST_GATEWAY = "host.lima.internal";

/**
 * Hostnames that mean "this machine" and therefore mean different machines on
 * the two sides of the VM boundary. `0.0.0.0` and `::` are here because they
 * are what a wildcard bind is written as, and a config's bind address is one
 * of the places a host URL gets built from. The bracketed spellings are what
 * `URL.hostname` reports for an IPv6 literal, brackets included.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "::", "[::]"]);

/**
 * A host URL a worker could actually dial: parseable, and http(s), which is
 * what `brevi worker --host` speaks (it derives the WebSocket URL from it).
 * Anything else, a typo, a bare `192.168.1.5:4400` with no scheme, an `ftp://`,
 * would provision a guest whose worker crash-loops under systemd, so callers
 * check this before doing any work rather than after.
 */
export function isUsableHostUrl(candidate: string): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
}

/**
 * Whether two host URLs name the same orchestrator, compared by origin so
 * `http://host:4400/` and `http://host:4400` are one host. Mirrors `sameHost`
 * in @brevi/worker's identity.ts deliberately: that is the comparison deciding
 * whether the guest's stored credential is presented at all, so anything this
 * calls the same host and that calls different would enroll a guest that then
 * refuses to use what it holds. A value that is not a URL falls back to an
 * exact match, exactly as it does there.
 */
export function sameHostOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return a === b;
  }
}

/**
 * The guest's view of a host URL that macOS wrote for itself. `localhost` on
 * the Mac is the Mac; inside the guest it is the guest, so a loopback URL
 * handed to `brevi worker` there would have it dial itself and never enroll.
 * Rewriting the host part to Lima's gateway is what makes the same
 * orchestrator reachable from both sides.
 *
 * A URL naming any other host is an address both sides already agree on and
 * passes through untouched, as does anything that is not a URL at all: this
 * only ever corrects the one case it recognizes.
 */
export function guestHostUrl(hostUrl: string): string {
  let url: URL;
  try {
    url = new URL(hostUrl);
  } catch {
    return hostUrl;
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) return hostUrl;
  url.hostname = LIMA_HOST_GATEWAY;
  // URL.toString() appends the root path for a bare origin; `brevi worker
  // --host` is compared by origin, but the trailing slash would still show up
  // in the unit file and in every log line, so drop it.
  return url.pathname === "/" && url.search === "" && url.hash === "" ? url.origin : url.toString();
}

export interface GuestOptions {
  hostUrl: string;
  /**
   * Single-use pairing token the guest enrolls with. Empty once the guest has
   * redeemed one: what it holds afterwards is a durable credential of its own
   * (see `brevi worker`), and a spent token on the command line would only be
   * refused before the daemon fell back to that credential.
   */
  token: string;
  workerName: string;
  concurrency: number;
  /** @brevi/cli version installed in the guest, e.g. "0.5.0". */
  cliVersion: string;
}

export interface TemplateOptions extends GuestOptions {
  cpus: number;
  memoryGiB: number;
  diskGiB: number;
}

/**
 * Every value below is interpolated into a single line of a systemd unit that
 * is itself written through a quoted heredoc, so a newline is the one thing
 * quoting cannot contain: it would end the directive, and a line matching the
 * heredoc delimiter would end the file. Refuse those outright rather than
 * emitting a script that means something other than it reads.
 */
function assertSingleLine(label: string, value: string): void {
  if (/[\n\r]/.test(value)) throw new Error(`the ${label} must not contain a line break`);
}

/**
 * Quotes a value for one systemd `ExecStart=` argument. Deliberately not
 * shQuote: systemd does its own word splitting and does not resolve escape
 * sequences inside single quotes, so a `'\''` shell idiom would reach the
 * process verbatim. Double quotes are the form systemd does unescape, and `%`
 * has to be doubled or systemd expands it as a specifier.
 */
function systemdQuote(value: string): string {
  return `"${value.replace(/[\\"]/g, "\\$&").replace(/%/g, "%%")}"`;
}

/** Lima instance names become directory and hostname components; reject anything outside the safe subset before it reaches limactl. */
export function assertValidLimaInstanceName(name: string): void {
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new Error(
      `"${name}" is not a valid Lima instance name; use only lowercase letters, digits and hyphens.`,
    );
  }
}

/** Prepends `indent` to every line of `text`, including blank lines, so it can be inlined under a YAML block scalar. */
function indentBlock(text: string, indent: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? indent : `${indent}${line}`))
    .join("\n");
}

/** The guest's `~/.brevi/config.json`: firecracker provider, the worker's concurrency, nothing else. */
export function renderGuestConfig(options: GuestOptions): string {
  const config = {
    sandbox: {
      provider: "firecracker",
      concurrency: options.concurrency,
    },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * How many tap devices the guest's network setup pre-creates. Mirrors
 * `ensureNetwork` in `commands/setup.ts`: a floor of 16, raised when the
 * worker runs more concurrent runs than that, since one microVM takes one tap.
 */
export function guestTapCount(concurrency: number): number {
  return Math.max(16, concurrency);
}

/**
 * The wrapper `GUEST_NETWORK_SERVICE_NAME` executes. It exists so the unit's
 * `ExecStart` can be a fixed absolute path with no shell in it: the script
 * brevi ships lives under the global npm root, which moves with the CLI's
 * version and with how node was installed, and resolving that inside a
 * systemd `ExecStart` would mean quoting a command substitution past both
 * systemd's own parser and its variable expansion. Resolving it here instead
 * also means an upgraded `@brevi/cli` is picked up on the next boot rather
 * than pinning the path this install happened to see.
 *
 * setup-network.sh is idempotent by design (it checks each iptables rule with
 * `-C` before adding it, and leaves an existing tap alone), so running it on
 * every boot converges rather than accumulating.
 */
export function renderGuestNetworkScript(options: GuestOptions): string {
  return `#!/usr/bin/env bash
# Reapplies brevi's microVM networking (tap devices, IPv4 forwarding, NAT).
# Generated by \`brevi mac install\`; hand edits here are overwritten.
#
# None of what setup-network.sh configures survives a reboot, and this VM is
# stopped and started by brevi's own supervisor whenever it goes idle, so this
# runs on every boot before the worker starts.
set -euo pipefail

script="$(npm root -g)/@brevi/cli/dist/scripts/setup-network.sh"
if [ ! -f "$script" ]; then
  echo "brevi: $script is missing; is @brevi/cli still installed globally?" >&2
  exit 1
fi

exec bash "$script" --taps ${guestTapCount(options.concurrency)} --user root
`;
}

/** The oneshot unit that runs the wrapper above, ordered ahead of the worker. */
export function renderGuestNetworkService(): string {
  return `[Unit]
Description=brevi microVM networking (tap devices, forwarding, NAT)
After=network-online.target
Wants=network-online.target
# The worker must never come up in front of this: it would register, be
# dispatched runs, and fail every one of them on its first clone.
Before=${GUEST_SERVICE_NAME}.service

[Service]
Type=oneshot
# The rules stay applied for the life of the boot, so systemd should treat the
# unit as active once it has run rather than as a job that ended.
RemainAfterExit=yes
ExecStart=${GUEST_NETWORK_SCRIPT_PATH}
User=root

[Install]
WantedBy=multi-user.target
`;
}

/** The systemd unit that runs `brevi worker` inside the guest, tagged as the managed macOS VM. */
export function renderGuestService(options: GuestOptions): string {
  assertSingleLine("host URL", options.hostUrl);
  assertSingleLine("pairing token", options.token);
  assertSingleLine("worker name", options.workerName);

  // The one translation between the two sides: everything else in
  // MacVmSettings is written from the Mac's point of view, including
  // `hostUrl`, which is what the supervisor out there polls. The guest needs
  // the same orchestrator under a name that resolves inside the VM.
  const hostUrl = guestHostUrl(options.hostUrl);

  // systemd requires an absolute path as the first token, and where npm drops
  // its global bin depends on how node was installed (/usr/bin under
  // NodeSource, /usr/local/bin elsewhere), so go through env and let the
  // service PATH resolve `brevi`.
  const execStart = [
    "/usr/bin/env brevi worker",
    "--host",
    systemdQuote(hostUrl),
    // Omitted once the guest is enrolled: a redeemed pairing token is dead,
    // and the daemon reconnects with the credential it bought instead.
    ...(options.token === "" ? [] : ["--token", systemdQuote(options.token)]),
    "--name",
    systemdQuote(options.workerName),
  ].join(" ");

  return `[Unit]
Description=brevi worker (managed macOS VM guest)
After=network-online.target
Wants=network-online.target
# Hard dependency, not just ordering: a worker whose microVMs have no egress
# accepts runs and then fails each one on its first clone, which is worse than
# this machine staying offline until the networking is back.
Requires=${GUEST_NETWORK_SERVICE_NAME}.service
After=${GUEST_NETWORK_SERVICE_NAME}.service

[Service]
Environment=BREVI_WORKER_OS=macos-vm
ExecStart=${execStart}
Restart=always
RestartSec=5
User=root
WorkingDirectory=/root

[Install]
WantedBy=multi-user.target
`;
}

/** Everything that turns a stock Ubuntu guest into a standard brevi Linux worker, run once at first boot. */
export function renderProvisionScript(options: GuestOptions): string {
  const guestConfig = renderGuestConfig(options);
  const guestService = renderGuestService(options);
  const networkScript = renderGuestNetworkScript(options);
  const networkService = renderGuestNetworkService();
  const serviceUnitPath = `/etc/systemd/system/${GUEST_SERVICE_NAME}.service`;
  const networkUnitPath = `/etc/systemd/system/${GUEST_NETWORK_SERVICE_NAME}.service`;

  return `#!/bin/bash
set -euo pipefail

# Lima may re-run provisioning on a later boot, so every step here is safe to
# repeat: apt-get install is already a no-op on installed packages, the node
# and cli installs are gated on what is already present, and the config and
# unit files are simply rewritten with their current (possibly unchanged)
# content.

echo "[brevi] installing apt prerequisites"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates git tar iproute2 iptables openssh-client

if ! command -v node >/dev/null 2>&1; then
  echo "[brevi] installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
else
  echo "[brevi] node is already installed, skipping"
fi

# The trailing "|| true" is load-bearing under set -e: npm list exits non-zero
# when the package is absent, which is exactly the first-boot case.
installed_cli_version="$(npm list -g --depth=0 @brevi/cli 2>/dev/null | sed -n 's/.*@brevi\\/cli@//p' || true)"
if [ "$installed_cli_version" != "${options.cliVersion}" ]; then
  echo "[brevi] installing @brevi/cli@${options.cliVersion}"
  npm install -g "@brevi/cli@${options.cliVersion}"
else
  echo "[brevi] @brevi/cli@${options.cliVersion} is already installed, skipping"
fi

echo "[brevi] writing the guest config"
mkdir -p /root/.brevi
cat > /root/.brevi/config.json <<'BREVI_GUEST_CONFIG'
${guestConfig}BREVI_GUEST_CONFIG
chmod 600 /root/.brevi/config.json

echo "[brevi] running brevi setup"
brevi setup --yes

# What brevi setup just configured (tap devices, ip_forward, the NAT and
# FORWARD rules) is all runtime state that a reboot drops. This VM is stopped
# and started by brevi's supervisor whenever it goes idle, so that has to be
# reapplied on every boot rather than only here.
echo "[brevi] installing the ${GUEST_NETWORK_SERVICE_NAME} boot-time networking service"
cat > ${GUEST_NETWORK_SCRIPT_PATH} <<'BREVI_GUEST_NETWORK_SCRIPT'
${networkScript}BREVI_GUEST_NETWORK_SCRIPT
chmod 755 ${GUEST_NETWORK_SCRIPT_PATH}

cat > ${networkUnitPath} <<'BREVI_GUEST_NETWORK_SERVICE'
${networkService}BREVI_GUEST_NETWORK_SERVICE
chmod 644 ${networkUnitPath}

echo "[brevi] installing the ${GUEST_SERVICE_NAME} service"
cat > ${serviceUnitPath} <<'BREVI_GUEST_SERVICE'
${guestService}BREVI_GUEST_SERVICE
chmod 600 ${serviceUnitPath}

systemctl daemon-reload
systemctl enable ${GUEST_NETWORK_SERVICE_NAME}
systemctl enable ${GUEST_SERVICE_NAME}
# The networking unit first, and on its own: the worker Requires= it, so
# starting the worker against a stale copy would drag the old unit along.
systemctl restart ${GUEST_NETWORK_SERVICE_NAME}
# restart, not "enable --now": on a re-run the service is already up, and only
# a restart picks up a changed host, token or worker name.
systemctl restart ${GUEST_SERVICE_NAME}
`;
}

/** The Lima instance template: nested virtualization on, no host mounts, the provisioning script inlined. */
export function renderLimaTemplate(options: TemplateOptions): string {
  const script = renderProvisionScript(options);
  const indentedScript = indentBlock(script, "      ");

  return `# Generated by \`brevi mac install\`; hand edits here are overwritten the
# next time that command runs.
vmType: "vz"
nestedVirtualization: true
rosetta: {enabled: false}
cpus: ${options.cpus}
memory: "${options.memoryGiB}GiB"
disk: "${options.diskGiB}GiB"
images:
  - location: "${GUEST_IMAGE.location}"
    arch: "${GUEST_IMAGE.arch}"
    digest: "${GUEST_IMAGE.digest}"
mounts: []
containerd: {system: false, user: false}
ssh: {loadDotSSHPubKeys: false}
provision:
  - mode: system
    script: |
${indentedScript}
`;
}
