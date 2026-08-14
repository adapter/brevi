#!/bin/sh
#
# Hosted installer: turns a stock Ubuntu/Debian server into a connected
# `brevi worker`. Published at https://brevi.dev/install.sh.
#
# Installs the `brevi` single-file executable, installs bubblewrap for the
# dedicated `brevi` system user, and runs the daemon as brevi-worker.service.
#
# Usage:
#   curl -fsSL https://brevi.dev/install.sh | sudo sh -s -- \
#     --host https://your-host:4400 --token <pairing token>
#
# Idempotent: re-run the same command (or `sudo brevi worker update`) to upgrade the
# binary in place without losing enrollment or settings. A re-run restarts the
# worker unit at the end, so the upgraded binary and settings are what is actually
# running when it reports success. See --help for every option, --check to
# preflight without installing, and --uninstall to remove everything this script created.
#
# POSIX sh only (runs under dash); no bashisms.
set -eu

# ---------------------------------------------------------------------------
# Defaults / option state
# ---------------------------------------------------------------------------

HOST=""
TOKEN=""
NAME=""
CONCURRENCY=""
VERSION=""
BINARY=""
CHECK=0
UNINSTALL=0
YES=0
BASE_URL="https://brevi.dev"
IMAGES_URL="https://images.brevi.dev"

# Matches sandbox.concurrency's ceiling in packages/shared/src/config.ts: what one
# machine's sandbox provider is expected to run at once, well under the wire protocol's
# own WORKER_MAX_CONCURRENCY. Validating it here keeps a rejection from landing after
# the service user and the binary are already installed.
MAX_CONCURRENCY=16

SERVICE_USER="brevi"
SERVICE_GROUP="brevi"
SERVICE_HOME="/var/lib/brevi"
BIN_PATH="/usr/local/bin/brevi"
LIB_DIR="/usr/local/lib/brevi"
ETC_DIR="/etc/brevi"
ENV_FILE="/etc/brevi/worker.env"
# What this installer created rather than found, so --uninstall removes exactly that. A
# `brevi` account that predates the install is somebody's to administer: it may hold
# other things, other services may run as it, and deleting it because an unrelated
# uninstall ran is not a mistake that can be undone. Data, never sourced, like the env
# files next to it.
OWNERSHIP_FILE="/etc/brevi/ownership.env"
WORKER_START="/usr/local/lib/brevi/worker-start.sh"
WORKER_UNIT="/etc/systemd/system/brevi-worker.service"
# Leftovers from an older installer. New installs never write these; --uninstall
# still removes them so an upgrade-then-uninstall of an old host is clean.
NETWORK_ENV_FILE="/etc/brevi/network.env"
NETWORK_START="/usr/local/lib/brevi/network-start.sh"
NETWORK_UNIT="/etc/systemd/system/brevi-network.service"

# Filled in as the script runs.
PROBLEMS=0
WARNINGS=0
BREVI_ARCH=""
RESOLVED_VERSION=""
REPLY=""
# Set by --check: preflight then reports, it never installs or changes anything.
REPORT_ONLY=0

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

info() { printf '==> %s\n' "$*"; }
step() { n="$1"; shift; printf '==> [%s/8] %s\n' "$n" "$*"; }
warnc() { printf 'WARNING: %s\n' "$*" >&2; WARNINGS=$((WARNINGS + 1)); }
err() { printf 'ERROR: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }
pass() { printf '  [ok]   %s\n' "$*"; }
fail() { printf '  [FAIL] %s\n' "$*" >&2; PROBLEMS=$((PROBLEMS + 1)); }
advise() { printf '  [warn] %s\n' "$*" >&2; WARNINGS=$((WARNINGS + 1)); }

# ---------------------------------------------------------------------------
# /dev/tty helpers (stdin is the piped script itself, so prompts must not read fd 0)
# ---------------------------------------------------------------------------

# Reads one line from the controlling terminal into $REPLY. $1 is the prompt text,
# $2 is the flag the user should pass instead when no tty is available (or --yes
# was given), which is what we die with rather than hanging.
#
# Note the redirection order below (2>/dev/null before </dev/tty): when /dev/tty
# cannot be opened (no controlling terminal, common when input is piped, e.g.
# `curl ... | sh`), dash prints its own "cannot open /dev/tty" diagnostic to
# whichever stderr was live when it tried to apply the failing redirection; putting
# the null-redirect first makes that diagnostic land in /dev/null instead of the
# user's terminal, leaving only our own message.
read_tty() {
  if [ "$YES" -eq 1 ]; then
    die "$2"
  fi
  printf '%s' "$1" >&2
  if ! IFS= read -r REPLY 2>/dev/null </dev/tty; then
    die "$2"
  fi
}

# Yes/no prompt; returns 0 for yes. Defaults to no when unattended.
confirm_tty() {
  if [ "$YES" -eq 1 ]; then
    return 0
  fi
  printf '%s [y/N] ' "$1" >&2
  if ! IFS= read -r reply 2>/dev/null </dev/tty; then
    return 1
  fi
  case "$reply" in
    y | Y | yes | YES) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# Minimal JSON field extraction (no jq dependency)
# ---------------------------------------------------------------------------

# Prints the flat object body for a top-level key, e.g. json_object "$manifest" binary
# -> "binary": {"name":"...","sha256":"...","sizeBytes":123}
# Assumes the object has no nested braces, true for the manifest.json shape here.
json_object() {
  printf '%s' "$1" | tr -d '\n' | grep -o "\"$2\"[[:space:]]*:[[:space:]]*{[^}]*}" | head -n1
}

# Prints the string value of a key, taking the first match left-to-right (top-level
# keys like npm's "version" can otherwise collide with the same key nested deeper).
json_field_string() {
  printf '%s' "$1" | grep -o "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -n1 | sed 's/.*:[[:space:]]*"\(.*\)"/\1/'
}

is_sha256() {
  printf '%s' "$1" | grep -Eq '^[0-9a-fA-F]{64}$'
}

# ---------------------------------------------------------------------------
# /etc/brevi/*.env values
#
# The worker env file exists for systemd's EnvironmentFile=, which parses it as data.
# Nothing sources it: the wrapper reads the environment systemd built, so no value here
# is ever evaluated as shell. What still has to be excluded is anything that would not
# survive the file format itself, so every value is checked against a whitelist on the
# way in and read back as data.
#
# The worker file is the only one that ever holds a secret, and only briefly: BREVI_TOKEN
# carries the single-use pairing token until the daemon has redeemed it for the durable
# credential in the service user's ~/.brevi/worker.json, and this script deletes the line
# as soon as the host confirms the enrolled worker connected. Hence 0640 root:brevi.
# ---------------------------------------------------------------------------

# Reads one KEY=value line out of an env file. The counterpart to writing them: never
# source these files.
env_file_value() {
  [ -f "$1" ] || return 0
  grep -m1 "^$2=" "$1" 2>/dev/null | cut -d= -f2- || true
}

# Drops one KEY=value line from an env file, preserving its mode and owner (the rewrite
# goes through a temp file in the same directory, so the replacement is atomic). Used to
# retire BREVI_TOKEN once the pairing token behind it has been redeemed.
env_file_forget() {
  [ -f "$1" ] || return 0
  grep -q "^$2=" "$1" || return 0
  tmp="$1.tmp.$$"
  # `|| true`: grep exits 1 when it prints nothing, which is a perfectly good outcome
  # here (the key was the file's only line) and must not abort the script.
  (umask 077; grep -v "^$2=" "$1" >"$tmp" || true)
  chmod --reference="$1" "$tmp" 2>/dev/null || chmod 0640 "$tmp"
  chown --reference="$1" "$tmp" 2>/dev/null || chown "root:$SERVICE_GROUP" "$tmp"
  mv "$tmp" "$1"
}

# Dies unless $2 is a single line matching the extended regex $3. $1 names the flag it
# came from and $4 describes what is allowed, so the failure says how to fix it.
require_plain_value() {
  if [ "$(printf '%s' "$2" | tr -d '\n\r')" != "$2" ]; then
    die "$1 must be a single line, and the value given spans more than one."
  fi
  if ! printf '%s' "$2" | grep -Eq "$3"; then
    die "$1 contains characters brevi will not write to $ENV_FILE: '$2'. $4"
  fi
}

require_positive_int() {
  case "$2" in
    '' | *[!0-9]*) die "$1 must be a positive integer, got '$2'" ;;
  esac
  [ "$2" -ge 1 ] || die "$1 must be a positive integer, got '$2'"
}

# ---------------------------------------------------------------------------
# Preflight checks. Each prints a pass/fail/warn line with a concrete fix.
# ---------------------------------------------------------------------------

check_linux() {
  os=$(uname -s)
  if [ "$os" = "Linux" ]; then
    pass "OS is Linux."
  else
    fail "this host reports '$os'; bwrap sandboxes need Linux."
  fi
}

check_arch() {
  arch=$(uname -m)
  case "$arch" in
    x86_64)
      BREVI_ARCH="x86_64"
      pass "architecture: $arch."
      ;;
    aarch64)
      BREVI_ARCH="aarch64"
      pass "architecture: $arch."
      ;;
    *)
      fail "unsupported architecture '$arch'; brevi worker needs x86_64 or aarch64."
      ;;
  esac
}

check_systemd() {
  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    pass "systemd is the running init system."
  else
    fail "systemd was not found (no systemctl on PATH, or /run/systemd/system is missing); this installer manages brevi worker as a systemd service. The daemon can still be run by hand with 'brevi worker --host <url>' if you manage it yourself."
  fi
}

check_bwrap() {
  if command -v bwrap >/dev/null 2>&1; then
    pass "bwrap is on PATH ($(command -v bwrap))."
  else
    advise "bwrap is not on PATH; step 6 installs bubblewrap with apt-get as root."
  fi
}

check_cgroups() {
  if [ ! -e /sys/fs/cgroup/cgroup.controllers ]; then
    if [ -e /.dockerenv ] || grep -q '^container=' /proc/1/environ 2>/dev/null; then
      fail "cgroup v2 is not visible here, and this looks like a container runtime that may be hiding it from its guests; install directly on the host (or a VM with nested virtualization), not inside a container. On bare metal, boot the kernel with systemd.unified_cgroup_hierarchy=1."
      return 0
    fi
    fail "cgroup v2 (unified hierarchy) is not active; boot the kernel with systemd.unified_cgroup_hierarchy=1."
    return 0
  fi
  pass "cgroup v2 (unified hierarchy) is active."
  check_service_cgroup
}

# The cgroup operation brevi-worker.service actually depends on: systemd creating a
# cgroup for the unit, applying the unit's restrictions, and moving the process into it.
# cgroup v2 being mounted says nothing about that succeeding, so this exercises it for
# real in a throwaway transient unit carrying the same properties the worker unit will,
# and reports whatever systemd said when it could not. Once the service user exists (any
# re-run or upgrade) the unit also runs as that user.
check_service_cgroup() {
  if ! command -v systemd-run >/dev/null 2>&1; then
    advise "systemd-run is not available, so the cgroup and service-restriction check could not be exercised. brevi-worker.service needs systemd to place it in its own cgroup under User= and ProtectControlGroups=."
    return 0
  fi
  if [ "$(id -u)" -ne 0 ]; then
    advise "not running as root, so the transient-unit cgroup check was skipped; re-run with sudo to exercise it."
    return 0
  fi

  # The transient unit's properties are collected in the positional parameters (a
  # function's own set, restored when it returns) so the two probe commands below can
  # share them without re-quoting.
  unit="brevi-preflight-$$"
  set -- --quiet --collect --wait --unit="$unit" \
    --property=NoNewPrivileges=yes \
    --property=ProtectSystem=full \
    --property=ProtectControlGroups=yes \
    --property=RestrictSUIDSGID=yes

  if id -u "$SERVICE_USER" >/dev/null 2>&1; then
    output=$(systemd-run "$@" \
      --property=User="$SERVICE_USER" \
      /bin/true 2>&1) && started=1 || started=0
    what="as $SERVICE_USER, with brevi-worker.service's cgroup and sandboxing properties"
  else
    output=$(systemd-run "$@" /bin/true 2>&1) && started=1 || started=0
    what="with brevi-worker.service's cgroup and sandboxing properties"
  fi

  if [ "$started" -eq 1 ]; then
    pass "systemd can start a unit $what."
  else
    systemctl reset-failed "$unit" >/dev/null 2>&1 || true
    fail "systemd could not start a transient unit $what, so brevi-worker.service would fail the same way at boot. systemd said: ${output:-(no output)}. The usual cause is a cgroup v2 hierarchy that is read-only or not delegated to this systemd (common inside containers and in some hosting images): install on the host or in a full VM, or mount /sys/fs/cgroup read-write and give this systemd Delegate=yes."
  fi
}

# tool:apt-package pairs. sha256sum/install both ship in coreutils; useradd/userdel/
# groupadd/groupdel ship in passwd; systemctl ships in systemd.
# shellcheck disable=SC2034 # documents the mapping the loop below re-derives
TOOL_LIST="curl:curl tar:tar gzip:gzip sha256sum:coreutils useradd:passwd install:coreutils systemctl:systemd git:git node:nodejs npm:npm"

check_commands() {
  missing_tools=""
  missing_packages=""
  # shellcheck disable=SC2086 # TOOL_LIST is a fixed, space-separated literal above
  for pair in $TOOL_LIST; do
    tool=${pair%%:*}
    pkg=${pair#*:}
    if ! command -v "$tool" >/dev/null 2>&1; then
      missing_tools="$missing_tools $tool"
      case " $missing_packages " in
        *" $pkg "*) ;;
        *) missing_packages="$missing_packages $pkg" ;;
      esac
    fi
  done
  if [ -z "$missing_tools" ]; then
    pass "required commands are present: curl, tar, gzip, sha256sum, useradd, install, systemctl, git, node, npm."
    return 0
  fi

  # --check reports, it never changes the machine, so the apt offer is skipped there.
  if [ "$REPORT_ONLY" -eq 0 ] && command -v apt-get >/dev/null 2>&1; then
    if confirm_tty "Missing commands:$missing_tools. Install with apt-get (packages:$missing_packages) now?"; then
      info "Running: apt-get update && apt-get install -y$missing_packages"
      # shellcheck disable=SC2086 # missing_packages is a controlled, space-separated list built above
      if apt-get update >&2 && apt-get install -y $missing_packages >&2; then
        still_missing=""
        # shellcheck disable=SC2086
        for pair in $TOOL_LIST; do
          tool=${pair%%:*}
          command -v "$tool" >/dev/null 2>&1 || still_missing="$still_missing $tool"
        done
        if [ -z "$still_missing" ]; then
          pass "installed missing packages:$missing_packages"
        else
          fail "still missing after apt-get install:$still_missing"
        fi
        return 0
      fi
      fail "apt-get install failed; install manually:$missing_packages"
      return 0
    fi
  fi
  fail "missing required commands:$missing_tools (install with your package manager, packages:$missing_packages)"
}

check_distro() {
  if [ -r /etc/os-release ]; then
    os_id=$(grep -E '^ID=' /etc/os-release | head -n1 | cut -d= -f2- | tr -d '"')
    os_id_like=$(grep -E '^ID_LIKE=' /etc/os-release | head -n1 | cut -d= -f2- | tr -d '"')
    os_pretty=$(grep -E '^PRETTY_NAME=' /etc/os-release | head -n1 | cut -d= -f2- | tr -d '"')
    case " $os_id $os_id_like " in
      *" debian "* | *" ubuntu "*)
        pass "distro: ${os_pretty:-$os_id}."
        return 0
        ;;
    esac
    advise "distro '${os_pretty:-$os_id}' is not Debian/Ubuntu; that is what brevi worker is tested on. Continuing anyway."
    return 0
  fi
  advise "/etc/os-release not found; cannot determine the distro. Continuing anyway."
}

check_disk_space() {
  avail_kb=$(df -Pk /var/lib 2>/dev/null | awk 'NR==2{print $4}')
  if [ -z "${avail_kb:-}" ]; then
    advise "could not determine free space under /var/lib."
    return 0
  fi
  avail_gb=$((avail_kb / 1024 / 1024))
  if [ "$avail_kb" -ge $((1 * 1024 * 1024)) ]; then
    pass "free space under /var/lib: ~${avail_gb} GB."
  else
    fail "only ~${avail_gb} GB free under /var/lib; brevi needs at least 1 GB for the worker home and run workspaces."
  fi
}

# Whether curl could connect at all (any HTTP status counts; only used for plain
# reachability, not for endpoints whose response body we need to check).
reachable() {
  code=$(curl -sS --max-time 8 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null) || return 1
  [ -n "$code" ] && [ "$code" != "000" ]
}

# $HOST is resolved before the preflight runs (see ensure_host), so this always probes
# the host this worker will actually dial rather than passing by default.
check_egress() {
  if [ -z "$HOST" ]; then
    fail "no host to check egress to; pass --host <url>."
  else
    health_url="${HOST%/}/api/health"
    body=$(curl -fsS --max-time 8 "$health_url" 2>/dev/null || true)
    case "$body" in
      *'"ok":true'*)
        pass "host reachable at $HOST (api/health ok)."
        ;;
      *)
        # A host with fleet.host configured hands out that listener's address in the
        # pairing command, and that listener serves exactly one thing: the authenticated
        # /ws/worker upgrade. It answers 404 to every other request by design, this probe
        # included, so a missing dashboard API is not a missing host. What this check is
        # really for is whether the port is open from here, and any HTTP answer settles
        # that; only silence is a failure.
        if reachable "$HOST"; then
          pass "host reachable at $HOST (it answers HTTP but serves no dashboard API, which is what a worker-channel-only listener looks like)."
        else
          fail "could not reach $HOST (no HTTP response, and no ok answer from $health_url). Check that the port is open through any firewall, and that the host is bound to 0.0.0.0 rather than 127.0.0.1 (brevi's default binds 127.0.0.1, which only accepts local connections and is a common cause of this)."
        fi
        ;;
    esac
  fi

  # npm is needed to resolve "latest" (unless --version/--binary) and to install
  # the agent CLIs (unless claude and codex are already on PATH).
  need_npm=0
  if [ -z "$BINARY" ] && [ -z "$VERSION" ]; then
    need_npm=1
  fi
  if ! command -v claude >/dev/null 2>&1 || ! command -v codex >/dev/null 2>&1; then
    need_npm=1
  fi
  if [ "$need_npm" -eq 1 ]; then
    if reachable "https://registry.npmjs.org/@brevi/cli/latest"; then
      pass "npm registry is reachable."
    else
      fail "could not reach the npm registry (https://registry.npmjs.org); needed to resolve the @brevi/cli version and to install the agent CLIs (claude, codex)."
    fi
  fi

  # The images host serves the worker binary. Skipped when --binary is given.
  if [ -z "$BINARY" ]; then
    if reachable "$IMAGES_URL/"; then
      pass "images host is reachable ($IMAGES_URL): the worker binary is published there."
    else
      fail "could not reach $IMAGES_URL; the worker binary is downloaded from there unless --binary is given. Open egress to it, or pass --images-url if you mirror those artifacts elsewhere."
    fi
  fi
}

run_preflight() {
  PROBLEMS=0
  WARNINGS=0
  check_linux
  check_arch
  check_systemd
  check_bwrap
  check_cgroups
  check_commands
  check_distro
  check_disk_space
  check_egress
}

# ---------------------------------------------------------------------------
# --check
# ---------------------------------------------------------------------------

do_check() {
  REPORT_ONLY=1
  if [ "$(id -u)" -ne 0 ]; then
    advise "not running as root; the transient-unit cgroup check cannot be fully verified."
  fi
  # So the egress checks look for already-provisioned artifacts where they would really
  # be, on a machine whose brevi account predates this installer.
  resolve_service_home
  # Resolved first, and required: egress to the pairing host is the check most likely to
  # fail on a fresh server, and reporting "ready" without having probed any host would
  # make --check answer a question it never asked.
  ensure_host
  info "Preflight check"
  run_preflight
  if [ "$PROBLEMS" -eq 0 ]; then
    info "ready ($WARNINGS warning(s))."
    exit 0
  fi
  err "$PROBLEMS problem(s) found, $WARNINGS warning(s)."
  exit 1
}

# ---------------------------------------------------------------------------
# --uninstall
# ---------------------------------------------------------------------------

do_uninstall() {
  info "Uninstalling brevi worker"
  # Counts what could not be removed. "Fully removed" is a claim an operator acts on, so
  # it is only printed when every step below actually succeeded.
  LEFTOVERS=0

  # Read before /etc/brevi is deleted below, which is where the record lives. No record
  # means no proof this installer created the account, and the safe reading of "no proof"
  # is "not ours": deleting an account somebody else administers cannot be undone, while
  # leaving one behind is a line of output and a one-command fix.
  resolve_service_home
  OWNED_USER=$(env_file_value "$OWNERSHIP_FILE" USER_CREATED)
  OWNED_GROUP=$(env_file_value "$OWNERSHIP_FILE" GROUP_CREATED)

  if command -v systemctl >/dev/null 2>&1; then
    for unit in brevi-worker.service brevi-network.service; do
      systemctl stop "$unit" >/dev/null 2>&1 || true
      systemctl disable "$unit" >/dev/null 2>&1 || true
    done
    info "Stopped and disabled brevi-worker.service and brevi-network.service (if present)."
  fi
  rm -f "$WORKER_UNIT" "$NETWORK_UNIT"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload >/dev/null 2>&1 || true
    systemctl reset-failed >/dev/null 2>&1 || true
  fi
  info "Removed systemd units."

  clean_legacy_network

  for path in "$BIN_PATH" "$LIB_DIR" "$ETC_DIR"; do
    if [ -e "$path" ]; then
      rm -rf "$path"
      info "Removed $path"
    fi
  done

  if [ "$OWNED_USER" = "1" ]; then
    if [ -e "$SERVICE_HOME" ]; then
      rm -rf "$SERVICE_HOME"
      info "Removed $SERVICE_HOME (config, enrollment, workspaces)."
    fi
  elif [ -e "$SERVICE_HOME/.brevi" ]; then
    # The account is not this installer's to empty out, so only brevi's own directory
    # inside its home goes, not the home itself.
    rm -rf "$SERVICE_HOME/.brevi"
    info "Removed $SERVICE_HOME/.brevi (config, enrollment, workspaces); left the rest of $SERVICE_HOME alone."
  fi

  if id -u "$SERVICE_USER" >/dev/null 2>&1; then
    if [ "$OWNED_USER" = "1" ]; then
      if userdel "$SERVICE_USER" >/dev/null 2>&1; then
        info "Removed user $SERVICE_USER."
      else
        err "could not remove user $SERVICE_USER (a process of theirs may still be running: check 'pgrep -u $SERVICE_USER')."
        LEFTOVERS=$((LEFTOVERS + 1))
      fi
    else
      info "Left user $SERVICE_USER in place: no record that this installer created it, so it is not this installer's to delete. Remove it yourself with 'userdel $SERVICE_USER' if it really is brevi's."
    fi
  fi
  if getent group "$SERVICE_GROUP" >/dev/null 2>&1; then
    if [ "$OWNED_GROUP" = "1" ]; then
      if groupdel "$SERVICE_GROUP" >/dev/null 2>&1; then
        info "Removed group $SERVICE_GROUP."
      else
        err "could not remove group $SERVICE_GROUP."
        LEFTOVERS=$((LEFTOVERS + 1))
      fi
    else
      info "Left group $SERVICE_GROUP in place: no record that this installer created it."
    fi
  fi

  if [ "$LEFTOVERS" -gt 0 ]; then
    err "brevi worker is NOT fully removed: $LEFTOVERS step(s) above did not complete. Fix them and re-run --uninstall."
    exit 1
  fi
  info "brevi worker is fully removed from this host."
}

# Best-effort removal of leftover tap/NAT state from an older install.
# Never fetches setup-network.sh; uses the local copy if this host still has one.
clean_legacy_network() {
  if [ -x "$LIB_DIR/setup-network.sh" ]; then
    info "Removing leftover tap devices and NAT rules"
    if ! "$LIB_DIR/setup-network.sh" --clean; then
      err "setup-network.sh --clean exited non-zero (see above); network state may remain. Inspect it with: ip -o link show | grep brevi-tap"
      LEFTOVERS=$((LEFTOVERS + 1))
    fi
    return
  fi
  if ! network_state_remains; then
    return
  fi
  info "Removing leftover tap devices (best effort; setup-network.sh is not present)"
  if command -v ip >/dev/null 2>&1; then
    ip -o link show 2>/dev/null | awk -F': ' '/brevi-tap/{print $2}' | while read -r iface; do
      iface=${iface%%@*}
      [ -n "$iface" ] || continue
      ip link delete "$iface" 2>/dev/null || true
    done
  fi
  rm -f /var/lib/brevi-network.state /etc/sysctl.d/99-brevi.conf
  if network_state_remains; then
    advise "leftover tap/NAT state may remain. Inspect it with: ip -o link show | grep brevi-tap"
  fi
}

# True when this host still carries network state from an older install.
network_state_remains() {
  [ -e /var/lib/brevi-network.state ] && return 0
  [ -e /etc/sysctl.d/99-brevi.conf ] && return 0
  if command -v ip >/dev/null 2>&1 && ip -o link show 2>/dev/null | grep -q 'brevi-tap'; then
    return 0
  fi
  return 1
}

# ---------------------------------------------------------------------------
# Install steps
# ---------------------------------------------------------------------------

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    err "this installer must run as root."
    printf 'Run:\n' >&2
    printf '  curl -fsSL %s/install.sh | sudo sh -s -- --host https://your-host:4400 --token <pairing token>\n' "$BASE_URL" >&2
    exit 1
  fi
}

resolve_version() {
  if [ -n "$BINARY" ]; then
    RESOLVED_VERSION="local"
    return 0
  fi
  if [ -n "$VERSION" ]; then
    RESOLVED_VERSION="$VERSION"
    return 0
  fi
  info "Resolving latest @brevi/cli version from npm"
  json=$(curl -fsS --max-time 15 "https://registry.npmjs.org/@brevi/cli/latest") || die "could not resolve the latest @brevi/cli version from the npm registry; pass --version or --binary."
  RESOLVED_VERSION=$(json_field_string "$json" version)
  [ -n "$RESOLVED_VERSION" ] || die "could not parse a version from the npm registry response; pass --version or --binary explicitly."
  info "Latest @brevi/cli version: $RESOLVED_VERSION"
}

# Points SERVICE_HOME at the account's real home when the account already exists. The
# default here is only what this installer would create; an account that predates it can
# live anywhere, and the daemon reads its ~/.brevi from passwd (as does `brevi worker
# update`, via getent), so anything this script does under an assumed /var/lib/brevi
# would be looking at a directory nothing else uses.
resolve_service_home() {
  existing_home=$(getent passwd "$SERVICE_USER" 2>/dev/null | cut -d: -f6)
  if [ -n "$existing_home" ] && [ "$existing_home" != "$SERVICE_HOME" ]; then
    SERVICE_HOME="$existing_home"
  fi
}

nologin_shell() {
  for candidate in /usr/sbin/nologin /sbin/nologin /bin/false; do
    if [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  printf '%s' "/bin/false"
}

create_service_user() {
  step 3 "Service user and directories"
  # Ownership is sticky: whatever an earlier run of this installer recorded stands, so a
  # re-run (which finds the account it created last time) never demotes itself to
  # "found it that way" and leaves a later uninstall unable to clean up after itself.
  created_group=$(env_file_value "$OWNERSHIP_FILE" GROUP_CREATED)
  created_user=$(env_file_value "$OWNERSHIP_FILE" USER_CREATED)

  if ! getent group "$SERVICE_GROUP" >/dev/null 2>&1; then
    groupadd --system "$SERVICE_GROUP"
    created_group=1
    info "Created group $SERVICE_GROUP"
  fi
  if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "$SERVICE_HOME" --create-home \
      --shell "$(nologin_shell)" --gid "$SERVICE_GROUP" "$SERVICE_USER"
    created_user=1
    info "Created user $SERVICE_USER (home $SERVICE_HOME)"
  else
    info "User $SERVICE_USER already exists (home $SERVICE_HOME)"
  fi

  mkdir -p "$ETC_DIR"
  {
    printf 'USER_CREATED=%s\n' "${created_user:-0}"
    printf 'GROUP_CREATED=%s\n' "${created_group:-0}"
    printf 'SERVICE_HOME=%s\n' "$SERVICE_HOME"
  } >"$OWNERSHIP_FILE"
  chmod 0644 "$OWNERSHIP_FILE"

  mkdir -p "$SERVICE_HOME"
  chown "$SERVICE_USER:$SERVICE_GROUP" "$SERVICE_HOME"

  mkdir -p "$ETC_DIR" "$LIB_DIR"
}

install_binary() {
  step 4 "Installing the brevi binary ($RESOLVED_VERSION, $BREVI_ARCH)"
  bin_tmp=$(mktemp)
  if [ -n "$BINARY" ]; then
    [ -f "$BINARY" ] || die "--binary $BINARY does not exist."
    cp "$BINARY" "$bin_tmp"
    chmod 0755 "$bin_tmp"
  else
    manifest_url="$IMAGES_URL/worker/$RESOLVED_VERSION/$BREVI_ARCH/manifest.json"
    info "Fetching $manifest_url"
    manifest=$(curl -fsS --max-time 20 "$manifest_url") || die "could not fetch $manifest_url"

    compressed_obj=$(json_object "$manifest" compressed)
    binary_obj=$(json_object "$manifest" binary)
    if [ -z "$compressed_obj" ] || [ -z "$binary_obj" ]; then
      die "could not parse manifest.json from $manifest_url"
    fi

    # The manifest has to name the release and architecture that were asked for, and
    # this is checked before anything is downloaded. The URL it came from is not proof
    # of either: a mispublished directory, or a cache or proxy answering with a stale
    # object, hands back an entirely self-consistent manifest for some other build, and
    # the digests below would then authenticate that other build into /usr/local/bin.
    # Mirrors the same check in packages/cli/src/lib/worker-binary.ts.
    manifest_version=$(json_field_string "$manifest" cliVersion)
    manifest_arch=$(json_field_string "$manifest" arch)
    [ "$manifest_version" = "$RESOLVED_VERSION" ] ||
      die "$manifest_url is for @brevi/cli '$manifest_version', expected '$RESOLVED_VERSION'"
    [ "$manifest_arch" = "$BREVI_ARCH" ] ||
      die "$manifest_url is for '$manifest_arch', expected '$BREVI_ARCH'"

    compressed_name=$(json_field_string "$compressed_obj" name)
    compressed_sha256=$(json_field_string "$compressed_obj" sha256)
    binary_sha256=$(json_field_string "$binary_obj" sha256)
    [ -n "$compressed_name" ] || die "manifest.json is missing compressed.name"
    is_sha256 "$compressed_sha256" || die "manifest.json's compressed.sha256 does not look like a sha256 digest"
    is_sha256 "$binary_sha256" || die "manifest.json's binary.sha256 does not look like a sha256 digest"

    download_url="$IMAGES_URL/worker/$RESOLVED_VERSION/$BREVI_ARCH/$compressed_name"
    gz_tmp=$(mktemp)
    info "Downloading $download_url"
    curl -fsSL --max-time 300 -o "$gz_tmp" "$download_url" || die "could not download $download_url"

    actual_gz_sha256=$(sha256sum "$gz_tmp" | awk '{print $1}')
    if [ "$actual_gz_sha256" != "$compressed_sha256" ]; then
      rm -f "$gz_tmp"
      die "sha256 mismatch for $compressed_name (expected $compressed_sha256, got $actual_gz_sha256)"
    fi

    gunzip -c "$gz_tmp" >"$bin_tmp"
    rm -f "$gz_tmp"
    actual_bin_sha256=$(sha256sum "$bin_tmp" | awk '{print $1}')
    if [ "$actual_bin_sha256" != "$binary_sha256" ]; then
      rm -f "$bin_tmp"
      die "sha256 mismatch for the decompressed binary (expected $binary_sha256, got $actual_bin_sha256)"
    fi
    chmod 0755 "$bin_tmp"
  fi

  # install to a temp name in the same directory, then mv into place: atomic, and
  # safe even while the previous binary is running under brevi-worker.service.
  install -m 0755 -o root -g root "$bin_tmp" "$BIN_PATH.new"
  mv -f "$BIN_PATH.new" "$BIN_PATH"
  rm -f "$bin_tmp"
  info "Installed $BIN_PATH"
}

validate_host() {
  case "$1" in
    http://* | https://*) ;;
    *) die "--host must look like http://... or https://... (got: $1)" ;;
  esac
  require_plain_value "--host" "$1" '^https?://[][A-Za-z0-9._~:/@%+-]+$' \
    "A pairing host is a base URL: scheme, host and port. Letters, digits and . _ ~ : / @ % + - [ ] are accepted."
}

# Resolves $HOST: keep an explicit --host, otherwise reuse what a previous install
# already wrote to the env file, otherwise prompt (never on a re-run that already
# has one, so upgrades never lose settings or re-prompt).
#
# Called before the preflight, deliberately: its egress check is the one that catches a
# firewalled or loopback-bound host, and it can only do that once it knows which host
# this worker is going to dial.
ensure_host() {
  if [ -n "$HOST" ]; then
    validate_host "$HOST"
    return 0
  fi
  if [ -f "$ENV_FILE" ]; then
    existing=$(env_file_value "$ENV_FILE" BREVI_HOST)
    if [ -n "$existing" ]; then
      HOST="$existing"
      info "Using previously configured host: $HOST"
      validate_host "$HOST"
      return 0
    fi
  fi
  read_tty "Host URL (e.g. https://your-host:4400): " "--host was not given and there is no /dev/tty to prompt on; pass --host <url> so the preflight can check egress to it"
  HOST="$REPLY"
  validate_host "$HOST"
}

install_wrapper_scripts() {
  # The unit carries EnvironmentFile=, so systemd (which parses that file as data, and
  # is the only thing that reads it) hands the settings to this wrapper through the
  # environment. Changing a setting rewrites only the env file, never a unit, so a
  # settings change needs no daemon-reload; the unit itself changes at most when
  # this script does.
  cat >"$LIB_DIR/worker-start.sh" <<'EOF'
#!/bin/sh
# Wrapper exec'd by brevi-worker.service. BREVI_HOST, BREVI_WORKER_NAME,
# BREVI_CONCURRENCY and BREVI_TOKEN come from /etc/brevi/worker.env via the unit's
# EnvironmentFile=, which systemd parses as data; nothing here sources that file, so
# no configured value is ever evaluated as shell.
#
# BREVI_TOKEN is only set until this machine has enrolled: the daemon redeems the
# pairing token once for the durable credential in ~/.brevi/worker.json, and the
# installer deletes the line from the env file as soon as the host confirms that
# happened, so a steady-state worker starts with no secret in its argv at all.
set -eu
: "${BREVI_HOST:?BREVI_HOST is not set; check EnvironmentFile=/etc/brevi/worker.env in brevi-worker.service}"
set -- --host "$BREVI_HOST"
[ -z "${BREVI_WORKER_NAME:-}" ] || set -- "$@" --name "$BREVI_WORKER_NAME"
[ -z "${BREVI_CONCURRENCY:-}" ] || set -- "$@" --concurrency "$BREVI_CONCURRENCY"
[ -z "${BREVI_TOKEN:-}" ] || set -- "$@" --token "$BREVI_TOKEN"
exec /usr/local/bin/brevi worker "$@"
EOF
  chmod 0755 "$LIB_DIR/worker-start.sh"
}

# Writes /etc/brevi/worker.env, keeping whatever is already there for any setting
# not given on this run, so re-running the installer to upgrade never loses config.
write_env_files() {
  existing_name=$(env_file_value "$ENV_FILE" BREVI_WORKER_NAME)
  existing_concurrency=$(env_file_value "$ENV_FILE" BREVI_CONCURRENCY)
  # Carried over only when an earlier run never got as far as confirming the worker
  # connected: a redeemed token is deleted from this file the moment it is confirmed.
  existing_token=$(env_file_value "$ENV_FILE" BREVI_TOKEN)

  final_name="${NAME:-$existing_name}"
  final_concurrency="${CONCURRENCY:-$existing_concurrency}"
  final_token="${TOKEN:-$existing_token}"

  validate_host "$HOST"
  if [ -n "$final_name" ]; then
    require_plain_value "--name" "$final_name" '^[A-Za-z0-9._@:/+ -]+$' \
      "A worker name may hold letters, digits, spaces and . _ @ : / + -"
  fi
  if [ -n "$final_concurrency" ]; then
    require_positive_int "--concurrency" "$final_concurrency"
  fi
  if [ -n "$final_token" ]; then
    require_plain_value "--token" "$final_token" '^[A-Za-z0-9._~+/=-]+$' \
      "A pairing token is the opaque string the host's Workers page minted; copy it verbatim."
  fi

  info "Writing $ENV_FILE"
  # Restored right after the redirection: leaving the umask narrowed would
  # silently change the mode of every file written later in the install.
  previous_umask=$(umask)
  umask 077
  {
    printf 'BREVI_HOST=%s\n' "$HOST"
    printf 'BREVI_WORKER_NAME=%s\n' "$final_name"
    printf 'BREVI_CONCURRENCY=%s\n' "$final_concurrency"
    [ -z "$final_token" ] || printf 'BREVI_TOKEN=%s\n' "$final_token"
  } >"$ENV_FILE"
  umask "$previous_umask"
  chmod 0640 "$ENV_FILE"
  chown "root:$SERVICE_GROUP" "$ENV_FILE"
}

write_units() {
  info "Writing systemd unit"
  cat >"$WORKER_UNIT" <<EOF
[Unit]
Description=brevi worker
After=network-online.target

[Service]
User=$SERVICE_USER
Group=$SERVICE_GROUP
EnvironmentFile=$ENV_FILE
ExecStart=$WORKER_START
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal
SyslogIdentifier=brevi-worker

# No AmbientCapabilities are granted: bwrap uses unprivileged user namespaces.
NoNewPrivileges=yes
ProtectSystem=full
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
}

# Drop leftover network units from an earlier install so an upgrade
# does not keep a oneshot that fetches a deleted script.
retire_legacy_network_unit() {
  if [ ! -f "$NETWORK_UNIT" ] && [ ! -f "$NETWORK_START" ] && [ ! -f "$NETWORK_ENV_FILE" ]; then
    return
  fi
  if command -v systemctl >/dev/null 2>&1; then
    systemctl stop brevi-network.service >/dev/null 2>&1 || true
    systemctl disable brevi-network.service >/dev/null 2>&1 || true
  fi
  rm -f "$NETWORK_UNIT" "$NETWORK_START" "$NETWORK_ENV_FILE" "$LIB_DIR/setup-network.sh"
  info "Removed leftover brevi-network.service from an earlier install."
}

configure_units() {
  step 5 "Wrapper scripts, config and units"
  install_wrapper_scripts
  write_env_files
  write_units
  retire_legacy_network_unit
  systemctl daemon-reload
}

# Safely quotes argv into a single string, for `su -c` which only takes one.
shell_quote_args() {
  out=""
  for arg in "$@"; do
    q=$(printf '%s' "$arg" | sed "s/'/'\\\\''/g")
    out="$out '$q'"
  done
  printf '%s' "$out"
}

run_as_service_user() {
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$SERVICE_USER" -- "$@"
  else
    su -s /bin/sh "$SERVICE_USER" -c "$(shell_quote_args "$@")"
  fi
}

install_bubblewrap() {
  step 6 "Installing bubblewrap and agent CLIs"
  if ! command -v bwrap >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      info "Running: apt-get update && apt-get install -y bubblewrap"
      apt-get update >&2 && apt-get install -y bubblewrap >&2 || die "apt-get install bubblewrap failed"
    else
      die "bwrap is not on PATH and apt-get is not available; install bubblewrap yourself."
    fi
  else
    info "bwrap is already on PATH ($(command -v bwrap))"
  fi
  bwrap_bin=$(command -v bwrap)
  if ! run_as_service_user "$bwrap_bin" --unshare-user --unshare-pid true; then
    die "bwrap cannot create unprivileged user namespaces as $SERVICE_USER. Enable kernel.unprivileged_userns_clone=1 (and check AppArmor)."
  fi
  info "bwrap works as $SERVICE_USER"
  install_agent_clis
}

# A bwrap worker runs the host binaries, so a stock Ubuntu box has to get
# claude and codex on PATH or every run fails at sandbox.exec("claude").
# Installed globally as root so the nologin service user can exec them from
# /usr/local/bin.
install_agent_clis() {
  if command -v claude >/dev/null 2>&1 && command -v codex >/dev/null 2>&1; then
    info "claude and codex are already on PATH"
  else
    command -v npm >/dev/null 2>&1 || die "npm is not on PATH; install nodejs and npm (apt-get install -y nodejs npm)."
    info "Running: npm install -g @anthropic-ai/claude-code @openai/codex"
    npm install -g @anthropic-ai/claude-code @openai/codex >&2 ||
      die "npm install -g of the agent CLIs failed"
  fi
  if ! run_as_service_user claude --version >/dev/null 2>&1; then
    die "claude is not runnable as $SERVICE_USER. Install it with: npm install -g @anthropic-ai/claude-code"
  fi
  if ! run_as_service_user codex --version >/dev/null 2>&1; then
    die "codex is not runnable as $SERVICE_USER. Install it with: npm install -g @openai/codex"
  fi
  info "claude and codex work as $SERVICE_USER"
}

# True when this machine already holds a durable credential for $HOST from an earlier
# enrollment (~/.brevi/worker.json, written by the daemon when it redeemed a pairing
# token). That file is the only fleet secret a worker keeps, so its presence is what
# "already enrolled" means. The host it was earned from is part of the answer: a
# credential another brevi instance issued is not one this host would honour, so a
# machine being re-pointed needs a pairing token exactly like a fresh one.
already_enrolled() {
  record="$SERVICE_HOME/.brevi/worker.json"
  [ -f "$record" ] || return 1
  contents=$(tr -d '\n' <"$record" 2>/dev/null) || return 1
  printf '%s' "$contents" | grep -q '"credential"[[:space:]]*:[[:space:]]*"[^"]' || return 1
  enrolled_host=$(json_field_string "$contents" host)
  [ "${enrolled_host%/}" = "${HOST%/}" ]
}

# Resolves the pairing token this install needs, prompting when it was not passed.
# Enrollment itself is the daemon's job: the token reaches it through BREVI_TOKEN in
# /etc/brevi/worker.env (see worker-start.sh), it is redeemed on the first connection
# for the credential in ~/.brevi/worker.json, and clear_redeemed_token() deletes the
# line once the host confirms that worker connected.
ensure_token() {
  if [ -n "$TOKEN" ]; then
    return 0
  fi
  if already_enrolled; then
    info "Already enrolled with $HOST (credential in $SERVICE_HOME/.brevi/worker.json); no pairing token needed. Pass --token to enroll again after a revoke."
    return 0
  fi
  # An earlier run that never got its worker confirmed leaves its token behind, still
  # unredeemed. Reuse it rather than making an unattended re-run fail for want of a
  # value that is already sitting in the env file.
  carried=$(env_file_value "$ENV_FILE" BREVI_TOKEN)
  if [ -n "$carried" ]; then
    TOKEN="$carried"
    info "Reusing the unredeemed pairing token left in $ENV_FILE by an earlier run. Pass --token to replace it."
    return 0
  fi
  read_tty "Pairing token: " "--token was not given and no /dev/tty is available to prompt; pass --token <token>"
  TOKEN="$REPLY"
  [ -n "$TOKEN" ] || die "a pairing token is required (--token)"
}

# How long to wait for the restarted worker to register, in seconds. It resolves and
# preflights its sandbox provider before it dials, which on a cold machine is the slow
# part, not the connection.
REGISTER_TIMEOUT=90

# The line connection.ts logs the moment the host accepts this machine's registration
# ("registered with <host> as worker ..."). Matching it in the unit's own journal is what
# confirms the install, rather than asking the host over HTTP: the address in a pairing
# command is the worker channel's listener whenever fleet.host is set, and that listener
# serves nothing but the authenticated /ws/worker upgrade, 404ing management endpoints
# like /api/workers by design. The daemon's own account of being accepted is also a
# stronger claim: it is this worker registering, not merely some worker being listed.
worker_registered_since() {
  journalctl -u brevi-worker.service --since "$1" --no-pager 2>/dev/null |
    grep -m1 '\[brevi\] registered with .* as worker' |
    sed 's/.*\[brevi\] //'
}

start_worker_and_confirm() {
  step 7 "Starting brevi-worker.service"

  # Taken before the restart, so only what the restarted process logs can satisfy the
  # wait below: on an upgrade this machine is already enrolled and already connected, and
  # the previous process's registration says nothing about the binary just installed.
  since=$(date '+%Y-%m-%d %H:%M:%S')

  systemctl enable brevi-worker.service
  # restart, not `enable --now`: `start` does nothing to an already-running worker, which
  # would leave it executing the previous binary with the previous settings.
  systemctl restart brevi-worker.service

  if ! command -v journalctl >/dev/null 2>&1; then
    warnc "journalctl is missing, so this install cannot confirm the worker registered. Check it with: systemctl status brevi-worker"
    return 0
  fi

  info "Waiting for the worker to register with $HOST (up to ${REGISTER_TIMEOUT}s)..."
  elapsed=0
  registered_line=""
  while [ "$elapsed" -lt "$REGISTER_TIMEOUT" ]; do
    registered_line=$(worker_registered_since "$since" || true)
    [ -z "$registered_line" ] || break
    # "activating" is a unit between automatic restarts, which is worth waiting out
    # (a host that is not up yet looks exactly like this); "failed" and "inactive" are
    # not: nothing is going to register, so say so now with the log that explains it.
    state=$(systemctl is-active brevi-worker.service 2>/dev/null || true)
    case "$state" in
      failed | inactive)
        err "brevi-worker.service is $state and never registered with $HOST."
        err "The pairing token is left in $ENV_FILE so a restart can retry it."
        journalctl -u brevi-worker.service --since "$since" -n 30 --no-pager >&2 2>/dev/null || true
        exit 1
        ;;
    esac
    sleep 1
    elapsed=$((elapsed + 1))
  done

  if [ -n "$registered_line" ]; then
    info "Worker registered with $HOST: $registered_line"
    clear_redeemed_token
  else
    err "The restarted worker did not register with $HOST within ${REGISTER_TIMEOUT}s."
    err "The pairing token is left in $ENV_FILE so a restart can retry it."
    err "The last of its log follows; the full one is: journalctl -u brevi-worker -n 50 --no-pager"
    journalctl -u brevi-worker.service --since "$since" -n 30 --no-pager >&2 2>/dev/null || true
    exit 1
  fi
}

# The host answered for this worker, so the pairing token has been redeemed for the
# credential in ~/.brevi/worker.json and is worth nothing now. Dropping the line leaves
# no secret on disk outside that file, and leaves later restarts (and reboots) starting
# the daemon with no token in its argv at all.
clear_redeemed_token() {
  [ -n "$(env_file_value "$ENV_FILE" BREVI_TOKEN)" ] || return 0
  env_file_forget "$ENV_FILE" BREVI_TOKEN
  info "Pairing token redeemed; removed it from $ENV_FILE (the credential in $SERVICE_HOME/.brevi/worker.json authenticates from here on)."
}

print_summary() {
  step 8 "Done"
  cat <<EOF

brevi worker is installed and connected to $HOST.

Service commands:
  systemctl status brevi-worker
  journalctl -u brevi-worker -f

Upgrade:
  sudo brevi worker update
  (or re-run the installer: curl -fsSL $BASE_URL/install.sh | sudo sh -s -- --host $HOST)

Uninstall:
  curl -fsSL $BASE_URL/install.sh | sudo sh -s -- --uninstall
EOF
}

do_install() {
  require_root

  # Before anything reads $SERVICE_HOME (the enrollment check below is the first), so a
  # `brevi` account that already exists is used where it actually lives.
  resolve_service_home

  # Before the preflight, and before anything is installed: an upgrade run usually passes
  # no --host and adopts the configured one, while a first install prompts here rather
  # than halfway through, so the egress check probes the host this worker will dial and a
  # blocked one is reported before the machine has been touched. The token prompt sits
  # here for the same reason, and because an interactive install should ask for
  # everything it needs before the bubblewrap install, not after it.
  ensure_host
  ensure_token

  step 1 "Preflight"
  run_preflight
  if [ "$PROBLEMS" -gt 0 ]; then
    err "$PROBLEMS problem(s) found; fix them (see above) and re-run, or run with --check for details only."
    exit 1
  fi
  info "Preflight passed ($WARNINGS warning(s))."

  step 2 "Resolving version"
  resolve_version

  create_service_user
  install_binary
  # The units and the env file (the pairing token included) are written before
  # provisioning: enrollment itself happens on the daemon's first connection, which
  # is the last step, so everything it needs has to be on disk before then.
  configure_units
  install_bubblewrap
  start_worker_and_confirm
  print_summary
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

usage() {
  cat <<EOF
Usage: install.sh [options]

Turns a stock Ubuntu/Debian server into a connected brevi worker (bwrap sandboxes).

  curl -fsSL https://brevi.dev/install.sh | sudo sh -s -- --host https://your-host:4400 --token <pairing token>

Pairing:
  --host <url>          brevi host to connect to (prompted for if omitted)
  --token <token>        pairing token (prompted for if omitted)

Worker settings:
  --name <name>          name shown on the host's dashboard (default: this machine's hostname)
  --concurrency <n>      dispatched runs to execute at once (1 to $MAX_CONCURRENCY)

Install source:
  --version <v>           exact @brevi/cli version to install (default: latest on npm)
  --binary <path>         install this local brevi executable instead of downloading one
  --base-url <url>        used in printed install/uninstall commands (default https://brevi.dev)
  --images-url <url>      where the worker binary is published (default https://images.brevi.dev)

Modes:
  --check                 run preflight only, print a summary, exit non-zero if not ready.
                          Needs the host it would pair with (--host, a previous install's
                          setting, or a prompt): egress to it is part of the preflight
  --uninstall              remove everything this script installs
  --yes                    never prompt (fail instead when a value is missing)
  -h, --help               show this help

Safe to re-run: re-running with the same or new flags upgrades the binary in
place and keeps any setting not passed again.
EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --host)
        [ $# -ge 2 ] || die "--host requires a value"
        HOST="$2"
        shift 2
        ;;
      --token)
        [ $# -ge 2 ] || die "--token requires a value"
        TOKEN="$2"
        shift 2
        ;;
      --name)
        [ $# -ge 2 ] || die "--name requires a value"
        NAME="$2"
        shift 2
        ;;
      --concurrency)
        [ $# -ge 2 ] || die "--concurrency requires a value"
        CONCURRENCY="$2"
        case "$CONCURRENCY" in
          '' | *[!0-9]*) die "--concurrency must be a positive integer, got '$CONCURRENCY'" ;;
        esac
        if [ "$CONCURRENCY" -lt 1 ] || [ "$CONCURRENCY" -gt "$MAX_CONCURRENCY" ]; then
          die "--concurrency must be between 1 and $MAX_CONCURRENCY, got '$CONCURRENCY'"
        fi
        shift 2
        ;;
      --taps)
        [ $# -ge 2 ] || die "--taps requires a value"
        warnc "--taps is ignored: bwrap workers do not use tap devices."
        shift 2
        ;;
      --version)
        [ $# -ge 2 ] || die "--version requires a value"
        VERSION="$2"
        shift 2
        ;;
      --binary)
        [ $# -ge 2 ] || die "--binary requires a value"
        BINARY="$2"
        shift 2
        ;;
      --base-url)
        [ $# -ge 2 ] || die "--base-url requires a value"
        BASE_URL="$2"
        shift 2
        ;;
      --images-url)
        [ $# -ge 2 ] || die "--images-url requires a value"
        IMAGES_URL="$2"
        shift 2
        ;;
      --check)
        CHECK=1
        shift
        ;;
      --uninstall)
        UNINSTALL=1
        shift
        ;;
      --yes)
        YES=1
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        printf 'unknown option: %s\n' "$1" >&2
        printf 'run with --help for usage\n' >&2
        exit 2
        ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

main() {
  parse_args "$@"

  if [ "$UNINSTALL" -eq 1 ]; then
    require_root
    do_uninstall
    exit 0
  fi

  if [ "$CHECK" -eq 1 ]; then
    do_check
  fi

  do_install
}

main "$@"
