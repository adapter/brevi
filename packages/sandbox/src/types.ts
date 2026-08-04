import type { FirecrackerConfig, SandboxProviderName } from "@brevi/shared";

export interface ExecOptions {
  /** Working directory inside the sandbox. Defaults to the workspace root. */
  cwd?: string;
  env?: Record<string, string>;
  /** Kill the command after this many milliseconds. */
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * A booted, isolated execution environment holding one run's workspace.
 *
 * Lifecycle: provider.create() -> writeFiles/exec/readFile... -> destroy().
 * The workspace (a git checkout) lives at `workspacePath` inside the sandbox.
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
}

export interface ProviderSelection {
  requested: "auto" | SandboxProviderName;
  firecracker: FirecrackerConfig;
}
