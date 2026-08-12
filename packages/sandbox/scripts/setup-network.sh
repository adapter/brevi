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
# Safe to re-run (brevi-network.service runs it at every boot, and the installer re-runs
# it on an upgrade): every run converges the pool, deleting taps beyond --taps and
# re-pointing the NAT rules when the egress interface changed. What it touched is
# recorded in /var/lib/brevi-network.state, so --clean undoes exactly that, including
# restoring the net.ipv4.ip_forward value this script found.
#
# Every firewall rule it installs is stamped with --comment brevi-network, and nothing
# else is ever deleted: a rule of yours about brevi's subnet or tap devices is yours.
#
# The addressing here MUST stay in sync with src/firecracker/network.ts:
#   brevi-tap<i>  host 172.30.<i/64>.<(i%64)*4 + 1>/30   guest ...+2
set -euo pipefail

TAPS=16
TAP_USER="${SUDO_USER:-root}"
EGRESS=""
CLEAN=0
SUBNET="172.30.0.0/16"
TAP_PREFIX="brevi-tap"
# Stamped on every firewall rule this script installs, and the thing cleanup selects on.
# Ownership has to be explicit: "every rule mentioning brevi's subnet or tap prefix" also
# describes rules an operator wrote about the same subnet (an extra log or deny rule, a
# rate limit), and deleting those on an uninstall or an egress change is not this
# script's business.
RULE_COMMENT="brevi-network"
SYSCTL_FILE="/etc/sysctl.d/99-brevi.conf"
# Deliberately not under the service user's home (/var/lib/brevi): the uninstaller
# deletes that directory, and cleanup needs this file to still be readable then.
STATE_FILE="/var/lib/brevi-network.state"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --taps) TAPS="$2"; shift 2 ;;
    --user) TAP_USER="$2"; shift 2 ;;
    --egress) EGRESS="$2"; shift 2 ;;
    --clean) CLEAN=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[[ "$(id -u)" -eq 0 ]] || { echo "this script must run as root (use sudo)" >&2; exit 1; }
[[ "$(uname -s)" == "Linux" ]] || { echo "microVM networking is Linux-only" >&2; exit 1; }

# State is read as data, never sourced: this file is written by a root service and read
# back by one, so evaluating it as shell would turn a stray character into root code.
state_value() {
  [[ -r "$STATE_FILE" ]] || return 0
  sed -n "s/^$1=//p" "$STATE_FILE" | head -n1
}

# Adds an iptables rule only when an identical one is not already present. Every rule
# goes in carrying $RULE_COMMENT, which is what makes it removable later without
# guessing: callers pass the match and target, this adds the ownership stamp.
ensure_rule() {
  local table="$1" chain="$2"; shift 2
  local target=("${@: -2}") match=("${@:1:$#-2}")
  local rule=("$chain" "${match[@]}")
  if [[ "$COMMENT_SUPPORTED" -eq 1 ]]; then
    rule+=(-m comment --comment "$RULE_COMMENT")
  fi
  rule+=("${target[@]}")
  iptables -t "$table" -C "${rule[@]}" 2>/dev/null || iptables -t "$table" -A "${rule[@]}"
}

# The comment match is part of every mainstream iptables, but a stripped kernel would
# fail every rule below rather than merely go untagged, so it is probed once: exit 2 is
# iptables reporting a parameter or module it cannot load, while exit 1 is the ordinary
# "no such rule" answer this probe expects. Without it the rules still go in, just
# untagged, and cleanup falls back to recognising them by their exact shape.
COMMENT_SUPPORTED=1
probe_comment_support() {
  local status=0
  iptables -t filter -C FORWARD -m comment --comment "${RULE_COMMENT}-probe" -j ACCEPT >/dev/null 2>&1 || status=$?
  if [[ "$status" -eq 2 ]]; then
    COMMENT_SUPPORTED=0
    echo "warning: this iptables cannot load the comment match, so brevi's rules go in untagged; cleanup will recognise them by their exact shape instead" >&2
  fi
}

# The exact rule bodies this script installs, with the egress interface left open and the
# ownership comment absent: what a brevi release from before the comment existed left
# behind. Those are still brevi's rules to remove, but they can only be recognised by
# being character-for-character one of the three it writes. Anything else that merely
# mentions the subnet or the tap prefix belongs to whoever wrote it.
LEGACY_RULE_PATTERNS=(
  "^-s ${SUBNET//./\\.} -o [^ ]+ -j MASQUERADE$"
  "^-i [^ ]+ -o ${TAP_PREFIX}\\+ -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT$"
  "^-i ${TAP_PREFIX}\\+ -o [^ ]+ -j ACCEPT$"
)

# True when a rule body (the part after "-A CHAIN") carries the ownership comment.
rule_is_tagged() {
  case "$1" in
    *"--comment \"$RULE_COMMENT\""* | *"--comment $RULE_COMMENT "* | *"--comment $RULE_COMMENT") return 0 ;;
  esac
  return 1
}

# True when a rule body is one of the untagged shapes an older brevi installed.
rule_is_legacy() {
  local rule="$1" pattern
  for pattern in "${LEGACY_RULE_PATTERNS[@]}"; do
    [[ "$rule" =~ $pattern ]] && return 0
  done
  return 1
}

# How many rules the last drop_our_rules deleted, so callers can report only when
# something actually changed.
DROPPED=0

# Deletes brevi's own rules from a chain, whatever egress interface they name (matching
# on the interface instead would strand them whenever the default route moved between
# install and cleanup, the one case cleanup most needs to survive). `mode` is "all" for
# tagged and legacy rules, or "legacy" for only the untagged ones an older brevi left.
drop_our_rules() {
  local table="$1" chain="$2" mode="$3" listed line rule status=0
  DROPPED=0
  # `iptables -S` prints each rule as "-A CHAIN <args>", i.e. ready to replay with -D.
  listed="$(iptables -t "$table" -S "$chain" 2>/dev/null || true)"
  [[ -n "$listed" ]] || return 0
  while IFS= read -r line; do
    rule="${line#-A "$chain" }"
    [[ "$rule" != "$line" ]] || continue
    if [[ "$mode" == "legacy" ]]; then
      rule_is_tagged "$rule" && continue
      rule_is_legacy "$rule" || continue
    else
      rule_is_tagged "$rule" || rule_is_legacy "$rule" || continue
    fi
    # shellcheck disable=SC2086 # every word is one iptables argument; none contain spaces
    if iptables -t "$table" -D "$chain" $rule 2>/dev/null; then
      DROPPED=$((DROPPED + 1))
    else
      status=1
    fi
  done <<<"$listed"
  return "$status"
}

# Retires the untagged rules an older brevi installed, so the tagged ones added below
# replace them rather than doubling up. A no-op once a run has converged, which is every
# boot after the first.
drop_legacy_rules() {
  local total=0
  drop_our_rules nat POSTROUTING legacy || echo "warning: could not remove every untagged brevi rule from nat POSTROUTING" >&2
  total=$((total + DROPPED))
  drop_our_rules filter FORWARD legacy || echo "warning: could not remove every untagged brevi rule from filter FORWARD" >&2
  total=$((total + DROPPED))
  [[ "$total" -eq 0 ]] || echo "replaced $total firewall rule(s) from an older brevi with tagged ones (--comment $RULE_COMMENT)"
}

# Every brevi-tap* device currently on the host, in creation-independent order.
existing_taps() {
  ip -o link show | awk -F': ' '{print $2}' | cut -d@ -f1 | grep "^${TAP_PREFIX}" || true
}

# Cleanup runs before the default route is resolved, deliberately: a host whose default
# route is gone (or has changed) is exactly when teardown still has to work.
if [[ "$CLEAN" -eq 1 ]]; then
  problems=0

  for dev in $(existing_taps); do
    echo "removing $dev"
    ip link del "$dev" || { echo "warning: could not delete $dev" >&2; problems=$((problems + 1)); }
  done

  drop_our_rules nat POSTROUTING all || { echo "warning: could not remove every brevi nat POSTROUTING rule" >&2; problems=$((problems + 1)); }
  drop_our_rules filter FORWARD all || { echo "warning: could not remove every brevi filter FORWARD rule" >&2; problems=$((problems + 1)); }

  rm -f "$SYSCTL_FILE"

  previous_forward="$(state_value IP_FORWARD_PREVIOUS)"
  if [[ "$previous_forward" == "0" || "$previous_forward" == "1" ]]; then
    sysctl -q -w "net.ipv4.ip_forward=$previous_forward"
    echo "removed $SYSCTL_FILE and restored net.ipv4.ip_forward=$previous_forward (its value before brevi)"
  else
    echo "removed $SYSCTL_FILE; no pre-brevi net.ipv4.ip_forward value was recorded, so the runtime setting is left as-is" >&2
  fi

  rm -f "$STATE_FILE"

  if [[ "$problems" -gt 0 ]]; then
    echo "brevi network teardown left $problems problem(s) behind (see above)" >&2
    exit 1
  fi
  echo "brevi network teardown complete"
  exit 0
fi

if [[ -z "$EGRESS" ]]; then
  EGRESS="$(ip -4 route show default | awk '{print $5; exit}')"
  [[ -n "$EGRESS" ]] || { echo "could not detect the default route interface; pass --egress" >&2; exit 1; }
fi

# Refuse to touch anything when 172.30.0.0/16 is already routed to something that is
# not one of our taps; brevi's subnet is currently not configurable.
conflict="$(ip -4 route show | awk -v prefix="$TAP_PREFIX" '
  $1 ~ /^172\.30\./ {
    dev = ""
    for (i = 1; i <= NF; i++) if ($i == "dev") dev = $(i + 1)
    if (index(dev, prefix) != 1) { print; exit }
  }')"
if [[ -n "$conflict" ]]; then
  echo "route \"$conflict\" collides with ${SUBNET}, which brevi's microVMs use; brevi's subnet is currently not configurable, so remove or renumber that route first" >&2
  exit 1
fi

echo "egress interface: $EGRESS"
echo "tap owner:        $TAP_USER"

# 0. Reconcile what a previous run left behind before adding anything. Rules pinned to an
# interface that is no longer the egress would otherwise stay installed forever, NATing
# nothing and outliving a --clean that only knows the current interface.
previous_egress="$(state_value EGRESS)"
if [[ -n "$previous_egress" && "$previous_egress" != "$EGRESS" ]]; then
  echo "egress interface changed ($previous_egress -> $EGRESS); removing the rules installed for $previous_egress"
  drop_our_rules nat POSTROUTING all || echo "warning: could not remove every stale nat POSTROUTING rule" >&2
  drop_our_rules filter FORWARD all || echo "warning: could not remove every stale filter FORWARD rule" >&2
fi

probe_comment_support
# Rules an older brevi installed carry no ownership comment; retire them so the tagged
# ones below take their place instead of sitting alongside a duplicate.
if [[ "$COMMENT_SUPPORTED" -eq 1 ]]; then
  drop_legacy_rules
fi

# 1. Forwarding + NAT. The pre-brevi runtime value is recorded once, on the first run
# that finds no state file, so a re-run never overwrites the original with brevi's own 1.
ip_forward_previous="$(state_value IP_FORWARD_PREVIOUS)"
if [[ "$ip_forward_previous" != "0" && "$ip_forward_previous" != "1" ]]; then
  ip_forward_previous="$(sysctl -n net.ipv4.ip_forward 2>/dev/null || true)"
fi
sysctl -q -w net.ipv4.ip_forward=1
printf 'net.ipv4.ip_forward = 1\n' > "$SYSCTL_FILE"
ensure_rule nat POSTROUTING -s "$SUBNET" -o "$EGRESS" -j MASQUERADE
ensure_rule filter FORWARD -i "$EGRESS" -o "${TAP_PREFIX}+" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
ensure_rule filter FORWARD -i "${TAP_PREFIX}+" -o "$EGRESS" -j ACCEPT

mkdir -p "$(dirname "$STATE_FILE")"
{
  printf 'EGRESS=%s\n' "$EGRESS"
  printf 'TAP_USER=%s\n' "$TAP_USER"
  printf 'TAPS=%s\n' "$TAPS"
  printf 'IP_FORWARD_PREVIOUS=%s\n' "$ip_forward_previous"
} > "$STATE_FILE"

# 2. Tap pool. Each VM gets its own /30 so guests cannot see each other.
#
# This runs at every boot (from brevi-network.service), so an existing device must
# converge rather than be left alone: re-apply the expected address and bring the
# link up. Ownership is a one-way ratchet, though: `ip tuntap add ... user` only
# takes effect at creation time, so a device already owned by someone else is left
# as-is (just reported), rather than silently handing it to a different user.
if [[ "$TAP_USER" =~ ^[0-9]+$ ]]; then
  target_uid="$TAP_USER"
else
  target_uid="$(id -u "$TAP_USER" 2>/dev/null || true)"
fi

for ((i = 0; i < TAPS; i++)); do
  dev="${TAP_PREFIX}${i}"
  third=$((i / 64))
  base=$(((i % 64) * 4))
  host_ip="172.30.${third}.$((base + 1))"

  if ip link show "$dev" >/dev/null 2>&1; then
    owner_uid=""
    if [[ -r "/sys/class/net/${dev}/owner" ]]; then
      owner_uid="$(cat "/sys/class/net/${dev}/owner" 2>/dev/null || true)"
    fi
    if [[ -n "$owner_uid" && "$owner_uid" != "-1" && -n "$target_uid" && "$owner_uid" != "$target_uid" ]]; then
      current_owner="$(id -un "$owner_uid" 2>/dev/null || echo "uid $owner_uid")"
      echo "warning: $dev is already owned by $current_owner, not $TAP_USER; leaving its ownership as-is" >&2
    fi
    ip addr replace "${host_ip}/30" dev "$dev"
    ip link set dev "$dev" up
    echo "$dev already exists, converged: address ${host_ip}/30, link up"
    continue
  fi

  ip tuntap add dev "$dev" mode tap user "$TAP_USER"
  ip addr add "${host_ip}/30" dev "$dev"
  ip link set dev "$dev" up
  echo "created $dev  host ${host_ip}  guest 172.30.${third}.$((base + 2))"
done

# 3. Shrink the pool to match --taps. A re-run with a smaller pool (a lowered
# sandbox.concurrency, say) would otherwise leave the surplus devices addressed and up
# forever. Anything still running in one of them loses its network, which is why the
# installer restarts the worker around this.
for dev in $(existing_taps); do
  index="${dev#"$TAP_PREFIX"}"
  [[ "$index" =~ ^[0-9]+$ ]] || continue
  if ((index >= TAPS)); then
    echo "removing $dev (beyond the requested pool of $TAPS)"
    ip link del "$dev" || echo "warning: could not delete $dev" >&2
  fi
done

cat <<EOF

brevi network setup complete.

Notes:
  - iptables rules and tap devices do not survive a reboot on their own. The worker
    installer runs this script from brevi-network.service at every boot; set that up
    yourself (or re-run this script) if you installed brevi some other way.
  - to undo everything, including the net.ipv4.ip_forward value this run recorded:
    sudo $0 --clean
EOF
