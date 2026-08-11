import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileExists } from "@brevi/sandbox";
import { BREVI_HOME } from "@brevi/shared";

/**
 * Installs and removes the launchd agent that supervises the managed macOS
 * worker VM: started at login, kept alive across a crash or a restart, since
 * that is the ticket's lifecycle requirement for `brevi mac supervise`.
 * `renderLaunchAgent` is pure (no fs, no exec) so its shape is testable off a
 * Mac; `installLaunchAgent`/`removeLaunchAgent`/`launchAgentInstalled` shell
 * out to `launchctl` and only ever run for real on macOS.
 */

/** Reverse-DNS label of the launchd agent that supervises the VM. */
export const LAUNCH_AGENT_LABEL = "dev.brevi.macvm";
/** ~/Library/LaunchAgents/dev.brevi.macvm.plist */
export const LAUNCH_AGENT_PATH = join(homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
/** Where the supervisor's output lands, since launchd gives it no terminal. */
export const SUPERVISOR_LOG_PATH = join(BREVI_HOME, "logs", "mac-vm.log");

/** launchd agents get a minimal PATH; these are where Homebrew (and thus limactl) lives. */
const AGENT_PATH_ENV = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
].join(":");

export interface LaunchAgentOptions {
  /** Absolute path to the node binary that runs the CLI. */
  nodePath: string;
  /** Absolute path to the brevi CLI entry point (dist/index.js). */
  cliPath: string;
}

/**
 * Path segments that mark a copy of the CLI as disposable rather than
 * installed. `npx @brevi/cli` (the invocation the docs lead with) unpacks the
 * package into npm's `_npx` cache and runs it from there; `npm cache clean`,
 * or npm's own eviction, deletes it. A `KeepAlive` launchd agent pointed at
 * such a path does not degrade, it fails to spawn on every retry forever, and
 * a stopped VM then has nothing left to wake it.
 */
const EPHEMERAL_PATH_SEGMENTS = ["/_npx/", "/_cacache/", "/.npm/_", "/private/var/folders/", "/tmp/"];

/**
 * Whether a resolved CLI entry point lives somewhere that may vanish under
 * it. Pure and exported so the rule is testable off a Mac; the caller copies
 * the CLI somewhere durable when this is true.
 */
export function isEphemeralCliPath(cliPath: string): boolean {
  return EPHEMERAL_PATH_SEGMENTS.some((segment) => cliPath.includes(segment));
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** The launchd property list, as XML. Pure, so its shape is testable off a Mac. */
export function renderLaunchAgent(options: LaunchAgentOptions): string {
  const nodePath = escapeXml(options.nodePath);
  const cliPath = escapeXml(options.cliPath);
  const logPath = escapeXml(SUPERVISOR_LOG_PATH);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(LAUNCH_AGENT_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${cliPath}</string>
    <string>mac</string>
    <string>supervise</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(AGENT_PATH_ENV)}</string>
  </dict>
</dict>
</plist>
`;
}

interface LaunchctlResult {
  exitCode: number;
  stderr: string;
}

function runLaunchctl(args: string[]): Promise<LaunchctlResult> {
  return new Promise((resolve) => {
    execFile("launchctl", args, { timeout: 15_000 }, (err, _stdout, stderr) => {
      if (!err) {
        resolve({ exitCode: 0, stderr: stderr ?? "" });
        return;
      }
      const code = (err as NodeJS.ErrnoException & { code?: number | string }).code;
      resolve({ exitCode: typeof code === "number" ? code : 1, stderr: stderr ?? err.message });
    });
  });
}

function guiDomain(): string {
  const uid = process.getuid?.() ?? 0;
  return `gui/${uid}`;
}

/** Write the plist and load it into the user's launchd domain, replacing any earlier copy. */
export async function installLaunchAgent(options: LaunchAgentOptions): Promise<void> {
  await mkdir(dirname(LAUNCH_AGENT_PATH), { recursive: true });
  await mkdir(dirname(SUPERVISOR_LOG_PATH), { recursive: true });
  await writeFile(LAUNCH_AGENT_PATH, renderLaunchAgent(options), "utf8");

  // Ignore the failure: bootout fails when nothing was loaded yet, which is
  // the common case on a first install.
  await runLaunchctl(["bootout", `${guiDomain()}/${LAUNCH_AGENT_LABEL}`]);

  const result = await runLaunchctl(["bootstrap", guiDomain(), LAUNCH_AGENT_PATH]);
  if (result.exitCode !== 0) {
    throw new Error(`launchctl bootstrap failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
  }
}

/**
 * Unload the agent without deleting its plist, so a running supervisor stops
 * acting while the VM is rebuilt. Reinstalling (or bootstrapping the plist
 * again) is what brings it back.
 *
 * Reprovisioning is exactly the window where a live supervisor is dangerous:
 * it polls on its own schedule, and an idle threshold reached midway through
 * `limactl shell` would stop the VM out from under the payload being applied
 * and leave the guest half configured.
 *
 * Returns whether anything was actually loaded.
 */
export async function suspendLaunchAgent(): Promise<boolean> {
  if (!(await launchAgentInstalled())) return false;
  await runLaunchctl(["bootout", `${guiDomain()}/${LAUNCH_AGENT_LABEL}`]);
  return true;
}

/** Unload and delete it; false when there was nothing installed. */
export async function removeLaunchAgent(): Promise<boolean> {
  const existed = await fileExists(LAUNCH_AGENT_PATH);
  // Tolerate absence: bootout fails when the agent isn't loaded, which is
  // exactly the case when there's nothing to remove.
  await runLaunchctl(["bootout", `${guiDomain()}/${LAUNCH_AGENT_LABEL}`]);
  if (!existed) return false;
  await rm(LAUNCH_AGENT_PATH, { force: true });
  return true;
}

export async function launchAgentInstalled(): Promise<boolean> {
  const result = await runLaunchctl(["print", `${guiDomain()}/${LAUNCH_AGENT_LABEL}`]);
  return result.exitCode === 0;
}
