#!/usr/bin/env bash
#
# One-time host setup for the brevi Firecracker sandbox provider.
#
# Does two things that require root, so that brevi itself never has to escalate:
#   1. Enables IPv4 forwarding + NAT so microVMs can reach the internet.
#   2. Pre-creates a pool of tap devices owned by an unprivileged user, which the
#      firecracker process can then open without any capabilities.
#
# Usage:
#   sudo packages/sandbox/scripts/setup-network.sh [--taps N] [--user NAME] [--egress IFACE]
#   sudo packages/sandbox/scripts/setup-network.sh --clean
#
# The addressing here MUST stay in sync with src/firecracker/network.ts:
#   brevi-tap<i>  host 172.30.<i/64>.<(i%64)*4 + 1>/30   guest ...+2
set -euo pipefail

TAPS=8
TAP_USER="${SUDO_USER:-root}"
EGRESS=""
CLEAN=0
SUBNET="172.30.0.0/16"
TAP_PREFIX="brevi-tap"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --taps) TAPS="$2"; shift 2 ;;
    --user) TAP_USER="$2"; shift 2 ;;
    --egress) EGRESS="$2"; shift 2 ;;
    --clean) CLEAN=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[[ "$(id -u)" -eq 0 ]] || { echo "this script must run as root (use sudo)" >&2; exit 1; }
[[ "$(uname -s)" == "Linux" ]] || { echo "microVM networking is Linux-only" >&2; exit 1; }

if [[ -z "$EGRESS" ]]; then
  EGRESS="$(ip -4 route show default | awk '{print $5; exit}')"
  [[ -n "$EGRESS" ]] || { echo "could not detect the default route interface; pass --egress" >&2; exit 1; }
fi

# Adds an iptables rule only when an identical one is not already present.
ensure_rule() {
  local table="$1"; shift
  iptables -t "$table" -C "$@" 2>/dev/null || iptables -t "$table" -A "$@"
}

remove_rule() {
  local table="$1"; shift
  iptables -t "$table" -D "$@" 2>/dev/null || true
}

if [[ "$CLEAN" -eq 1 ]]; then
  for dev in $(ip -o link show | awk -F': ' '{print $2}' | cut -d@ -f1 | grep "^${TAP_PREFIX}" || true); do
    echo "removing $dev"
    ip link del "$dev" || true
  done
  remove_rule nat POSTROUTING -s "$SUBNET" -o "$EGRESS" -j MASQUERADE
  remove_rule filter FORWARD -i "$EGRESS" -o "${TAP_PREFIX}+" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  remove_rule filter FORWARD -i "${TAP_PREFIX}+" -o "$EGRESS" -j ACCEPT
  echo "brevi network teardown complete"
  exit 0
fi

echo "egress interface: $EGRESS"
echo "tap owner:        $TAP_USER"

# 1. Forwarding + NAT.
sysctl -q -w net.ipv4.ip_forward=1
printf 'net.ipv4.ip_forward = 1\n' > /etc/sysctl.d/99-brevi.conf
ensure_rule nat POSTROUTING -s "$SUBNET" -o "$EGRESS" -j MASQUERADE
ensure_rule filter FORWARD -i "$EGRESS" -o "${TAP_PREFIX}+" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
ensure_rule filter FORWARD -i "${TAP_PREFIX}+" -o "$EGRESS" -j ACCEPT

# 2. Tap pool. Each VM gets its own /30 so guests cannot see each other.
for ((i = 0; i < TAPS; i++)); do
  dev="${TAP_PREFIX}${i}"
  third=$((i / 64))
  base=$(((i % 64) * 4))
  host_ip="172.30.${third}.$((base + 1))"

  if ip link show "$dev" >/dev/null 2>&1; then
    echo "$dev already exists, leaving it alone"
    continue
  fi

  ip tuntap add dev "$dev" mode tap user "$TAP_USER"
  ip addr add "${host_ip}/30" dev "$dev"
  ip link set dev "$dev" up
  echo "created $dev  host ${host_ip}  guest 172.30.${third}.$((base + 2))"
done

cat <<EOF

brevi network setup complete.

Notes:
  - iptables rules are not persisted across reboots; re-run this script or add the
    rules to your firewall manager if you need them to survive a restart.
  - tap devices disappear on reboot as well. Re-run with the same --taps value.
  - to undo everything: sudo $0 --clean
EOF
