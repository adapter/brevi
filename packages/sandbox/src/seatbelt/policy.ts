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

/** Home-relative trees an agent must never read: keys, tokens, cookies. */
const SENSITIVE_HOME_SUBPATHS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".netrc",
  ".npmrc",
  ".config/gh",
  ".config/gcloud",
  ".docker",
  "Library/Keychains",
  "Library/Cookies",
  "Library/Application Support/com.apple.TCC",
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

; System plumbing common toolchains touch.
(allow sysctl-read)
(allow mach-lookup)
(allow ipc-posix*)
(allow iokit-open)

; Network: outbound open (agents call their APIs); inbound binds allowed on
; loopback only, for dev servers the run starts itself.
(allow network-outbound)
(allow system-socket)
(allow network-bind (local ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
`;
}
