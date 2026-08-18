import { homedir } from "node:os";
import { join } from "node:path";
import { BREVI_HOME } from "@brevi/shared";

/**
 * SBPL (Seatbelt) profile for one run's sandbox. The same containment idea
 * Codex CLI and Anthropic's sandbox-runtime use on macOS: deny by default,
 * reads broadly allowed, writes only under the run root and tmp, outbound
 * network open for the agent. This is policy-based confinement, not the
 * namespace isolation bwrap gives on Linux: the process sees the real
 * filesystem, so the profile explicitly denies the credential trees an
 * exfiltration-shaped prompt would go for.
 */

/**
 * Home-relative trees an agent must never read: keys, tokens, cookies. A
 * deny list on top of a broad read-allow is only as good as its coverage, so
 * this errs toward walling off whole credential/secret homes rather than
 * individual files.
 */
const SENSITIVE_HOME_SUBPATHS = [
  // The operator's own agent CLI logins; runs get per-run copies under the
  // sandbox root, never these.
  ".claude",
  ".claude.json",
  ".codex",
  ".grok",
  // SSH, GPG, cloud, and package-registry credentials.
  ".ssh",
  ".aws",
  ".azure",
  ".gnupg",
  ".kube",
  ".oci",
  ".netrc",
  ".vault-token",
  ".git-credentials",
  ".config/git",
  ".npmrc",
  ".pypirc",
  ".cargo/credentials.toml",
  ".gem/credentials",
  ".terraform.d",
  ".config/gh",
  ".config/gcloud",
  ".config/op",
  ".config/doctl",
  ".config/configstore",
  ".docker",
  ".wrangler",
  // Shell history routinely contains pasted secrets and tokens.
  ".zsh_history",
  ".bash_history",
  ".sh_history",
  ".local/share/fish",
  // macOS credential and personal data stores. Modern Safari cookies live
  // under Containers, not the legacy Library/Cookies path.
  "Library/Keychains",
  "Library/Cookies",
  "Library/HTTPStorages",
  "Library/Application Support/com.apple.TCC",
  "Library/Application Support/Firefox",
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/Chromium",
  "Library/Application Support/BraveSoftware",
  "Library/Containers/com.apple.Safari",
  "Library/Containers/com.apple.mail",
  "Library/Mail",
  "Library/Messages",
];

/** SBPL string literal: double quotes with backslash escaping. */
function sbplString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

const subpaths = (paths: string[]): string =>
  paths.map((path) => `(subpath ${sbplString(path)})`).join(" ");

export interface SeatbeltPolicyOptions {
  /** The per-run root (workspace/ and home/ live under it): read-write. */
  rootDir: string;
  /** Real HOME of the worker user, whose secrets the profile walls off. */
  userHome?: string;
  /** ~/.brevi override (tests only). */
  breviHome?: string;
}

/**
 * The profile text for one run. Later rules win in SBPL, so the shape is:
 * allow reads everywhere, then deny the sensitive trees (the operator's
 * credentials and all of ~/.brevi, which holds config.json with tokens and
 * every other run's workspace), then re-allow exactly this run's root and
 * the shared read-only caches beneath ~/.brevi.
 */
export function seatbeltPolicy(options: SeatbeltPolicyOptions): string {
  const home = options.userHome ?? homedir();
  const breviHome = options.breviHome ?? BREVI_HOME;
  const sensitive = SENSITIVE_HOME_SUBPATHS.map((subpath) => join(home, subpath));

  return `(version 1)
(deny default)

; Process lifecycle: the agent forks and execs constantly.
(allow process-fork)
(allow process-exec*)
(allow process-info* (target same-sandbox))
(allow signal (target same-sandbox))

; Reads: broadly allowed so host toolchains (node, git, agent CLIs) work,
; minus the operator's credential trees and the rest of ~/.brevi.
(allow file-read*)
(deny file-read* ${subpaths(sensitive)})
(deny file-read* (subpath ${sbplString(breviHome)}))
(allow file-read* (subpath ${sbplString(options.rootDir)}))
(allow file-read* (subpath ${sbplString(join(breviHome, "cache"))}))
; Path resolution needs the spine above the run root: metadata only, so the
; rest of ~/.brevi stays unreadable.
(allow file-read-metadata (literal ${sbplString(breviHome)}) (literal ${sbplString(join(breviHome, "workspaces"))}))

; Writes: the run root, tmp, and the devices a shell session needs.
(allow file-write* (subpath ${sbplString(options.rootDir)}))
(allow file-write* (subpath "/private/tmp") (subpath "/private/var/tmp"))
(allow file-write* (subpath "/private/var/folders"))
(allow file-write-data (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper"))
(allow file-write* (regex #"^/dev/ttys[0-9]*$"))
(allow file-ioctl (literal "/dev/dtracehelper") (regex #"^/dev/ttys[0-9]*$"))
(allow pseudo-tty)

; System plumbing common toolchains touch. mach-lookup is broad, so the
; services that read the operator's session (pasteboard, TCC, keychain
; agent, LaunchServices registration) are denied back out; later rules win.
(allow sysctl-read)
(allow mach-lookup)
(deny mach-lookup
  (global-name "com.apple.pboard")
  (global-name "com.apple.pasteboard.1")
  (global-name "com.apple.tccd")
  (global-name "com.apple.tccd.system")
  (global-name "com.apple.SecurityServer")
  (global-name "com.apple.security.agent")
  (global-name "com.apple.coreservices.launchservicesd"))
(allow ipc-posix*)

; Network: outbound over IP (agents call their APIs over TCP), plus the one
; unix socket name resolution needs (mDNSResponder). Scoping unix-domain
; outbound to just the resolver deliberately excludes every other host
; service socket, so a run cannot connect to the operator's SSH-agent socket
; to use loaded keys, wherever that socket lives. Inbound binds are loopback
; only, for dev servers the run starts itself.
(allow network-outbound
  (remote ip "*:*")
  (literal "/private/var/run/mDNSResponder")
  (literal "/var/run/mDNSResponder"))
(allow system-socket)
(allow network-bind (local ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
`;
}
