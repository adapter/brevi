import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { IMAGES_DIR } from "@brevi/shared";
import { runCommand } from "../exec.js";

/** Private half of the keypair baked into the rootfs by `scripts/build-rootfs.sh`. */
export const SSH_KEY_PATH = join(IMAGES_DIR, "id_ed25519");

const SSH_OPTIONS = [
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "LogLevel=ERROR",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=5",
];

const VALID_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface SshTarget {
  keyPath: string;
  host: string;
  user: string;
}

export function sshArgs(target: SshTarget, remoteCommand: string): string[] {
  return ["-i", target.keyPath, ...SSH_OPTIONS, `${target.user}@${target.host}`, remoteCommand];
}

/** Quotes a value for safe interpolation into a POSIX shell command run in the guest. */
export function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Builds the single shell command ssh runs in the guest for one `exec` call. */
export function remoteCommandLine(
  cwd: string,
  env: Record<string, string>,
  command: string,
  args: string[],
): string {
  const assignments = Object.entries(env)
    .filter(([name]) => VALID_ENV_NAME.test(name))
    .map(([name, value]) => `${name}=${quote(value)}`);
  const invocation = [command, ...args].map(quote).join(" ");
  return `cd ${quote(cwd)} && exec env ${[...assignments, invocation].join(" ")}`;
}

/** Polls `ssh true` with backoff until the guest's sshd answers. */
export async function waitForSsh(target: SshTarget, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let backoffMs = 250;
  let lastError = "no attempt completed";

  while (Date.now() < deadline) {
    const result = await runCommand("ssh", sshArgs(target, "true"), { timeoutMs: 5_000 });
    if (result.exitCode === 0) return;
    lastError = result.stderr.trim() || `exit ${result.exitCode}`;
    await delay(backoffMs);
    backoffMs = Math.min(backoffMs * 2, 2_000);
  }

  throw new Error(
    `microVM at ${target.host} did not accept ssh within ${timeoutMs}ms: ${lastError}`,
  );
}
