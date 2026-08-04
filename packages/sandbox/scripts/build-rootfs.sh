#!/usr/bin/env bash
#
# Builds the ext4 rootfs that brevi's Firecracker microVMs boot from.
#
# The image is an Ubuntu userland exported from a docker build, with:
#   - node 22, git, curl, tar, ripgrep, jq
#   - the coding agent CLI (@anthropic-ai/claude-code)
#   - openssh-server plus the public half of ~/.brevi/images/id_ed25519 in
#     /root/.ssh/authorized_keys (this is brevi's exec channel)
#   - a ~40 line /sbin/init that mounts the pseudo filesystems, configures eth0 from
#     the kernel `ip=` argument, and execs sshd. No systemd: boot is ~1s.
#
# Requires: Linux, root (loop mount + mkfs.ext4), docker, ssh-keygen.
#
# Usage:
#   sudo packages/sandbox/scripts/build-rootfs.sh [--size-mb 2048] [--with-kernel]
#
# The kernel is NOT built here. Grab a known-good uncompressed vmlinux from the
# Firecracker CI bucket (what their quickstart uses) with --with-kernel, or manually:
#   curl -fsSL -o ~/.brevi/images/vmlinux \
#     https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.10/x86_64/vmlinux-6.1.102
# Any kernel works as long as it has virtio-blk, virtio-net, ext4 and serial built in.
set -euo pipefail

SIZE_MB=2048
WITH_KERNEL=0
NODE_VERSION="22.14.0"
KERNEL_URL="https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.10/x86_64/vmlinux-6.1.102"
IMAGE_TAG="brevi-rootfs:latest"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --size-mb) SIZE_MB="$2"; shift 2 ;;
    --with-kernel) WITH_KERNEL=1; shift ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[[ "$(id -u)" -eq 0 ]] || { echo "this script must run as root (use sudo)" >&2; exit 1; }
[[ "$(uname -s)" == "Linux" ]] || { echo "building an ext4 rootfs requires Linux" >&2; exit 1; }
command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }

# Under sudo, resolve BREVI_HOME against the invoking user, not root.
owner="${SUDO_USER:-$(id -un)}"
owner_home="$(getent passwd "$owner" | cut -d: -f6)"
BREVI_HOME="${BREVI_HOME:-${owner_home:-$HOME}/.brevi}"
IMAGES_DIR="$BREVI_HOME/images"
ROOTFS="$IMAGES_DIR/rootfs.ext4"
KEY="$IMAGES_DIR/id_ed25519"

mkdir -p "$IMAGES_DIR"

# 1. Keypair. Generated once and reused; regenerating it invalidates existing images.
if [[ ! -f "$KEY" ]]; then
  echo "==> generating $KEY"
  ssh-keygen -t ed25519 -N '' -C "brevi-sandbox" -f "$KEY" >/dev/null
fi

# 2. Guest userland, built with docker so apt caching and layering do the heavy lifting.
echo "==> building $IMAGE_TAG"
build_dir="$(mktemp -d)"
cp "${KEY}.pub" "$build_dir/authorized_keys"

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
  case "$arg" in ip=*) ipcfg="${arg#ip=}" ;; esac
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

RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

RUN ssh-keygen -A \\
 && rm -f /sbin/init \\
 && mkdir -p /root/.ssh /workspace /run/sshd \\
 && chmod 700 /root/.ssh \\
 && printf 'PermitRootLogin prohibit-password\\nPasswordAuthentication no\\nUseDNS no\\nAcceptEnv *\\n' \\
      > /etc/ssh/sshd_config.d/brevi.conf \\
 && printf 'nameserver 1.1.1.1\\nnameserver 8.8.8.8\\n' > /etc/resolv.conf \\
 && printf 'brevi\\n' > /etc/hostname \\
 && printf '127.0.0.1 localhost brevi\\n' > /etc/hosts

COPY authorized_keys /root/.ssh/authorized_keys
COPY init /sbin/init
RUN chmod 600 /root/.ssh/authorized_keys && chmod 755 /sbin/init
DOCKERFILE

docker build -t "$IMAGE_TAG" "$build_dir"

# 3. Export the container filesystem into a fresh ext4 image.
echo "==> writing ${ROOTFS} (${SIZE_MB} MiB)"
mnt="$(mktemp -d)"
cid=""
cleanup() {
  mountpoint -q "$mnt" && umount "$mnt"
  rmdir "$mnt" 2>/dev/null || true
  [[ -n "$cid" ]] && docker rm -f "$cid" >/dev/null 2>&1
  rm -rf "$build_dir"
  return 0
}
trap cleanup EXIT

rm -f "$ROOTFS"
truncate -s "${SIZE_MB}M" "$ROOTFS"
mkfs.ext4 -q -F -L brevi-rootfs "$ROOTFS"
mount -o loop "$ROOTFS" "$mnt"

cid="$(docker create "$IMAGE_TAG")"
docker export "$cid" | tar -C "$mnt" -xf -

sync
umount "$mnt"
e2fsck -fp "$ROOTFS" >/dev/null || true

# 4. Optional kernel download.
if [[ "$WITH_KERNEL" -eq 1 ]]; then
  echo "==> downloading vmlinux"
  curl -fsSL -o "$IMAGES_DIR/vmlinux" "$KERNEL_URL"
fi

chown -R "$owner" "$IMAGES_DIR"

cat <<EOF

Done.
  rootfs: $ROOTFS
  key:    $KEY
  kernel: $IMAGES_DIR/vmlinux $([[ -f "$IMAGES_DIR/vmlinux" ]] && echo "(present)" || echo "(MISSING - see --with-kernel)")

Next: sudo packages/sandbox/scripts/setup-network.sh --taps 8 --user "$owner"
EOF
