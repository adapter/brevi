import type { SandboxLaunch } from "../types.js";

/** Apple ships sandbox-exec here on every macOS; there is nothing to install. */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * The argv that runs `command` under the profile. A small sh trampoline
 * carries the working directory, since sandbox-exec has no --chdir.
 */
export function wrapInSeatbelt(
  profilePath: string,
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): SandboxLaunch {
  return {
    file: SANDBOX_EXEC,
    args: ["-f", profilePath, "/bin/sh", "-c", 'cd "$0" && exec "$@"', cwd, command, ...args],
    env,
  };
}
