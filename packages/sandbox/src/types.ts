import type { SandboxProviderName } from "@brevi/shared";

export interface ExecOptions {
  /** Working directory inside the sandbox. Defaults to the workspace root. */
  cwd?: string;
  env?: Record<string, string>;
  /** Kill the command after this many milliseconds. */
  timeoutMs?: number;
  /**
   * Terminates the command (SIGTERM, then SIGKILL after a grace period) when
   * aborted. exec still resolves normally, with a non-zero exitCode, after the
   * process is gone, so awaiting it is how callers wait out a cancellation.
   */
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface ExecResult {
  exitCode: number;
  /**
   * True when `timeoutMs` elapsed and the command was killed. A timeout is
   * reported as exit code 124, but a child can also exit 124 on its own, so
   * this is the only reliable way to tell the two apart.
   */
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/** How a host process can open an interactive session inside a sandbox. */
export type SandboxConnection = {
  kind: "local";
  workspacePath: string;
};

/** argv to spawn a command inside the sandbox (exec and PTY attach). */
export interface SandboxLaunch {
  file: string;
  args: string[];
  /** Sanitized environment for the bwrap process and, via --setenv, the inner command. */
  env: Record<string, string>;
}

/**
 * A booted, isolated execution environment holding one run's workspace.
 *
 * Lifecycle: provider.create() -> writeFiles/exec/readFile... -> destroy(),
 * or release() to stop compute while keeping the disk for a later
 * provider.rehydrate(). The workspace (a git checkout) lives at
 * `workspacePath` inside the sandbox.
 */
export interface Sandbox {
  id: string;
  provider: SandboxProviderName;
  /** Absolute path of the workspace inside the sandbox. */
  workspacePath: string;
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
  /** Copy a local directory into the sandbox at `destPath`. */
  pushDirectory(localPath: string, destPath: string): Promise<void>;
  /** Copy a directory out of the sandbox to a local path. */
  pullDirectory(srcPath: string, localPath: string): Promise<void>;
  writeFile(path: string, contents: string): Promise<void>;
  readFile(path: string): Promise<string>;
  /** How to open an interactive session inside this sandbox from the host. */
  connection(): SandboxConnection;
  /** argv that runs `command` inside the sandbox (PTY attach uses the same wrap as exec). */
  wrap(command: string, args: string[], cwd?: string, options?: { newSession?: boolean }): SandboxLaunch;
  /**
   * Stop the sandbox's compute but keep its filesystem on host disk so
   * provider.rehydrate() can bring it back later.
   */
  release(): Promise<void>;
  destroy(): Promise<void>;
}

export interface CreateSandboxOptions {
  /** Stable id used for naming resources (typically the run id). */
  id: string;
  /** Environment variables available to every exec (agent credentials etc.). */
  env?: Record<string, string>;
}

export interface SandboxProvider {
  name: SandboxProviderName;
  /** Throws with a human-readable reason if this provider can't run on this host. */
  ensureAvailable(): Promise<void>;
  create(options: CreateSandboxOptions): Promise<Sandbox>;
  /**
   * Boot a sandbox back up from the disk a previous release() retained.
   * Throws when no retained disk exists for the id.
   */
  rehydrate(options: CreateSandboxOptions): Promise<Sandbox>;
  /** Delete a retained sandbox's disk without booting it. Idempotent. */
  discard(id: string): Promise<void>;
}


