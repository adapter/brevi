#!/usr/bin/env bash
#
# Builds the ext4 rootfs that brevi's Firecracker microVMs boot from.
#
# The image is an Ubuntu userland exported from a docker build, with:
#   - node 22, git, curl, tar, ripgrep, jq
#   - playwright's Chromium at /opt/ms-playwright (agents demo UIs without a per-run download)
#   - the coding agent CLIs (@anthropic-ai/claude-code for implementation, @openai/codex for the adversarial review step)
#   - ccusage, for live per-model cost capture from the Claude Code transcripts during a run
#   - openssh-server; /root/.ssh/authorized_keys starts out holding the public half of
#     ~/.brevi/images/id_ed25519 (empty with --no-ssh-key), and is overwritten at boot
#     from the brevi.authorized_keys= kernel arg when the host passes one (this is
#     brevi's exec channel; it lets one prebuilt image serve every machine)
#   - a ~40 line /sbin/init that mounts the pseudo filesystems, configures eth0 from
#     the kernel `ip=` argument, injects brevi.authorized_keys=, and execs sshd. No
#     systemd: boot is ~1s.
#
# Requires: Linux, root (loop mount + mkfs.ext4), docker, ssh-keygen.
#
# Usage:
#   sudo packages/sandbox/scripts/build-rootfs.sh [--size-mb 2048] [--with-kernel] [--brevi-home PATH] [--no-ssh-key]
#
# --no-ssh-key skips keypair generation and bakes an empty authorized_keys file instead;
# CI uses this for published images, which trust no key until a host injects one at boot.
#
# The kernel is NOT built here. Grab a known-good uncompressed vmlinux from the
# Firecracker CI bucket (what their quickstart uses) with --with-kernel, or manually:
#   curl -fsSL -o ~/.brevi/images/vmlinux \
#     https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.10/x86_64/vmlinux-6.1.102
# Any kernel works as long as it has virtio-blk, virtio-net, ext4 and serial built in.
set -euo pipefail

SIZE_MB=4096
WITH_KERNEL=0
NODE_VERSION="22.14.0"
KERNEL_URL="https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.10/x86_64/vmlinux-6.1.102"
IMAGE_TAG="brevi-rootfs:latest"
BREVI_HOME_OVERRIDE=""
NO_SSH_KEY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --size-mb) SIZE_MB="$2"; shift 2 ;;
    --with-kernel) WITH_KERNEL=1; shift ;;
    --brevi-home) BREVI_HOME_OVERRIDE="$2"; shift 2 ;;
    --no-ssh-key) NO_SSH_KEY=1; shift ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[[ "$(id -u)" -eq 0 ]] || { echo "this script must run as root (use sudo)" >&2; exit 1; }
[[ "$(uname -s)" == "Linux" ]] || { echo "building an ext4 rootfs requires Linux" >&2; exit 1; }
command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }

# Under sudo, resolve BREVI_HOME against the invoking user, not root. --brevi-home wins
# so the TS caller can pass the exact directory brevi itself uses.
owner="${SUDO_USER:-$(id -un)}"
owner_home="$(getent passwd "$owner" | cut -d: -f6)"
BREVI_HOME="${BREVI_HOME_OVERRIDE:-${BREVI_HOME:-${owner_home:-$HOME}/.brevi}}"
IMAGES_DIR="$BREVI_HOME/images"
ROOTFS="$IMAGES_DIR/rootfs.ext4"
KEY="$IMAGES_DIR/id_ed25519"
MANIFEST="$ROOTFS.manifest.json"
# Must match ROOTFS_VERSION in packages/sandbox/src/firecracker/rootfs.ts; bump both
# together whenever the rootfs contract changes (a new required guest tool etc.).
MANIFEST_VERSION=2

mkdir -p "$IMAGES_DIR"

# Everything is built at .tmp paths and only moved into place after e2fsck passes, so a
# failed build never replaces a working image or leaves a key/rootfs mismatch.
mnt=""
cid=""
build_dir=""
cleanup() {
  if [[ -n "$mnt" ]] && mountpoint -q "$mnt"; then umount "$mnt" || true; fi
  [[ -n "$mnt" ]] && rmdir "$mnt" 2>/dev/null || true
  [[ -n "$cid" ]] && docker rm -f "$cid" >/dev/null 2>&1 || true
  [[ -n "$build_dir" ]] && rm -rf "$build_dir" || true
  rm -f "$ROOTFS.tmp" "$KEY.tmp" "$KEY.tmp.pub" "$MANIFEST.tmp"
  return 0
}
trap cleanup EXIT

# 1. Keypair. Generated once and reused; regenerating it invalidates existing from-source
# images built with it baked in. Skipped entirely with --no-ssh-key: published images bake
# in no key and trust whatever the host injects at boot instead (see brevi.authorized_keys=
# in the init script below).
key_tmp=""
if [[ "$NO_SSH_KEY" -eq 0 ]] && [[ ! -f "$KEY" ]]; then
  echo "==> generating $KEY"
  rm -f "$KEY.tmp" "$KEY.tmp.pub"
  ssh-keygen -t ed25519 -N '' -C "brevi-sandbox" -f "$KEY.tmp" >/dev/null
  key_tmp="$KEY.tmp"
fi

# 2. Guest userland, built with docker so apt caching and layering do the heavy lifting.
echo "==> building $IMAGE_TAG"
build_dir="$(mktemp -d)"
if [[ "$NO_SSH_KEY" -eq 1 ]]; then
  : > "$build_dir/authorized_keys"
else
  cp "${key_tmp:-$KEY}.pub" "$build_dir/authorized_keys"
fi

cat > "$build_dir/init" <<'INIT'
#!/bin/sh
# brevi microVM init (PID 1). Deliberately tiny: mount, network, sshd.
set -u

mount -t proc     proc     /proc
mount -t sysfs    sysfs    /sys
mount -t devtmpfs devtmpfs /dev 2>/dev/null || true
mkdir -p /dev/pts /dev/shm
mount -t devpts devpts /dev/pts
mount -t tmpfs  tmpfs  /dev/shm
mount -t tmpfs  tmpfs  /run
mkdir -p /run/sshd
mount -o remount,rw /

ip link set lo up

# The kernel configures eth0 itself when built with CONFIG_IP_PNP, but we re-apply the
# same settings here so images also boot on kernels without it.
# ip=<client>:<server>:<gateway>:<netmask>:<hostname>:<device>:<autoconf>
mask2cidr() {
  bits=0
  for octet in $(echo "$1" | tr '.' ' '); do
    while [ "$octet" -gt 0 ]; do
      bits=$((bits + octet % 2))
      octet=$((octet / 2))
    done
  done
  echo "$bits"
}

for arg in $(cat /proc/cmdline); do
  case "$arg" in
    ip=*) ipcfg="${arg#ip=}" ;;
    brevi.authorized_keys=*) authorized_keys_b64="${arg#brevi.authorized_keys=}" ;;
  esac
done

if [ -n "${ipcfg:-}" ]; then
  client="$(echo "$ipcfg" | cut -d: -f1)"
  gateway="$(echo "$ipcfg" | cut -d: -f3)"
  netmask="$(echo "$ipcfg" | cut -d: -f4)"
  device="$(echo "$ipcfg" | cut -d: -f6)"
  [ -n "$device" ] || device=eth0
  ip addr flush dev "$device" 2>/dev/null || true
  ip addr add "${client}/$(mask2cidr "$netmask")" dev "$device"
  ip link set "$device" up
  [ -n "$gateway" ] && ip route replace default via "$gateway" dev "$device"
fi

# The host passes its own public key at boot instead of it being baked into the image, so
# one prebuilt image can serve every machine (falls back to whatever authorized_keys the
# image was built with, baked or empty, when the host passes none).
if [ -n "${authorized_keys_b64:-}" ]; then
  mkdir -p /root/.ssh
  chmod 700 /root/.ssh
  echo "$authorized_keys_b64" | base64 -d > /root/.ssh/authorized_keys
  chmod 600 /root/.ssh/authorized_keys
fi

# -D: foreground (stays PID 1). -e: log to stderr, which is the serial console and
# therefore ends up in the host-side firecracker.log.
exec /usr/sbin/sshd -D -e
INIT

cat > "$build_dir/Dockerfile" <<DOCKERFILE
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \\
      ca-certificates curl git jq less openssh-server ripgrep tar unzip xz-utils \\
      iproute2 iputils-ping tzdata \\
 && rm -rf /var/lib/apt/lists/*

# Node from the official tarball: predictable version, no extra apt repos.
RUN set -eux; \\
    case "\$(dpkg --print-architecture)" in \\
      amd64) node_arch=x64 ;; \\
      arm64) node_arch=arm64 ;; \\
      *) echo "unsupported architecture" >&2; exit 1 ;; \\
    esac; \\
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-\${node_arch}.tar.xz" \\
      | tar -xJ -C /usr/local --strip-components=1 --no-same-owner

RUN npm install -g @anthropic-ai/claude-code @openai/codex ccusage && npm cache clean --force

# Chromium for playwright demos, baked at a fixed path. The orchestrator sets
# PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright so agents never download a browser.
RUN PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright npx -y playwright install --with-deps chromium \\
 && npm cache clean --force && rm -rf /root/.npm /tmp/*

RUN ssh-keygen -A \\
 && rm -f /sbin/init \\
 && mkdir -p /root/.ssh /workspace /run/sshd \\
 && chmod 700 /root/.ssh \\
 && printf 'PermitRootLogin prohibit-password\\nPasswordAuthentication no\\nUseDNS no\\nAcceptEnv *\\n' \\
      > /etc/ssh/sshd_config.d/brevi.conf

COPY authorized_keys /root/.ssh/authorized_keys
COPY init /sbin/init
RUN chmod 600 /root/.ssh/authorized_keys && chmod 755 /sbin/init
DOCKERFILE

docker build -t "$IMAGE_TAG" "$build_dir"

# 3. Export the container filesystem into a fresh ext4 image.
echo "==> writing ${ROOTFS} (${SIZE_MB} MiB)"
mnt="$(mktemp -d)"

rm -f "$ROOTFS.tmp"
truncate -s "${SIZE_MB}M" "$ROOTFS.tmp"
mkfs.ext4 -q -F -L brevi-rootfs "$ROOTFS.tmp"
mount -o loop "$ROOTFS.tmp" "$mnt"

cid="$(docker create "$IMAGE_TAG")"
docker export "$cid" | tar -C "$mnt" -xf -

# docker manages /etc/resolv.conf, /etc/hostname and /etc/hosts as runtime bind
# mounts, so writing them in the Dockerfile never reaches the exported image
# (they come out empty, leaving the guest without DNS). Write them into the
# mounted filesystem instead.
printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > "$mnt/etc/resolv.conf"
printf 'brevi\n' > "$mnt/etc/hostname"
printf '127.0.0.1 localhost brevi\n' > "$mnt/etc/hosts"

sync
umount "$mnt"

# -fp exits 0 (clean), 1 (errors fixed) or 2 (fixed, reboot advised); anything higher
# means the image is broken and must not replace a working one.
fsck_status=0
e2fsck -fp "$ROOTFS.tmp" >/dev/null || fsck_status=$?
if [[ "$fsck_status" -gt 2 ]]; then
  echo "e2fsck failed with status $fsck_status; discarding the broken image" >&2
  exit 1
fi

mv "$ROOTFS.tmp" "$ROOTFS"
if [[ -n "$key_tmp" ]]; then
  mv "$KEY.tmp" "$KEY"
  mv "$KEY.tmp.pub" "$KEY.pub"
fi

# 4. Optional kernel download.
if [[ "$WITH_KERNEL" -eq 1 ]]; then
  echo "==> downloading vmlinux"
  curl -fsSL -o "$IMAGES_DIR/vmlinux" "$KERNEL_URL"
fi

# 5. Build manifest: lets brevi's preflight tell an image built by an older brevi (which
# may lack a required guest tool) apart from a current one, and catch an empty/corrupt file.
built_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$MANIFEST.tmp" <<MANIFEST
{"version": $MANIFEST_VERSION, "builtAt": "$built_at", "node": "$NODE_VERSION", "tools": ["claude-code", "codex", "playwright-chromium"]}
MANIFEST
mv "$MANIFEST.tmp" "$MANIFEST"

chown -R "$owner" "$IMAGES_DIR"

cat <<EOF

Done.
  rootfs:   $ROOTFS
  manifest: $MANIFEST
  key:      $([[ "$NO_SSH_KEY" -eq 1 ]] && echo "none baked in (--no-ssh-key); injected at boot via brevi.authorized_keys=" || echo "$KEY")
  kernel:   $IMAGES_DIR/vmlinux $([[ -f "$IMAGES_DIR/vmlinux" ]] && echo "(present)" || echo "(MISSING - see --with-kernel)")

Next: sudo packages/sandbox/scripts/setup-network.sh --taps 16 --user "$owner"
EOF
