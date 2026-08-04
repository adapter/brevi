import {
  cp,
  mkdir,
  readFile as readHostFile,
  rm,
  writeFile as writeHostFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { WORKSPACES_DIR } from "@brevi/shared";
import { runCommand } from "../exec.js";
import { resolveHostPath } from "../paths.js";
import type {
  CreateSandboxOptions,
  ExecOptions,
  ExecResult,
  Sandbox,
  SandboxProvider,
} from "../types.js";

/** Host variables kept for sandboxed commands unless overridden by the caller. */
const INHERITED_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "SHELL", "TERM", "TMPDIR", "USER"];

/**
 * Development fallback provider: runs commands directly on the host in a per-run
 * workspace directory. It provides no isolation, only the same interface as the
 * Firecracker provider so the orchestrator can run on macOS or hosts without KVM.
 */
export class ProcessProvider implements SandboxProvider {
  readonly name = "process" as const;

  async ensureAvailable(): Promise<void> {
    // Always available: no host requirements beyond a writable BREVI_HOME.
  }

  async create(options: CreateSandboxOptions): Promise<Sandbox> {
    const rootDir = join(WORKSPACES_DIR, options.id);
    const workspacePath = join(rootDir, "workspace");
    await mkdir(workspacePath, { recursive: true });
    return new ProcessSandbox(options.id, rootDir, workspacePath, options.env ?? {});
  }
}

class ProcessSandbox implements Sandbox {
  readonly provider = "process" as const;
  readonly id: string;
  readonly workspacePath: string;
  readonly #rootDir: string;
  readonly #env: Record<string, string>;

  constructor(id: string, rootDir: string, workspacePath: string, env: Record<string, string>) {
    this.id = id;
    this.#rootDir = rootDir;
    this.workspacePath = workspacePath;
    this.#env = env;
  }

  async exec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    return runCommand(command, args, {
      cwd: resolveHostPath(this.workspacePath, options.cwd),
      env: { ...baseEnv(), ...this.#env, ...options.env },
      timeoutMs: options.timeoutMs,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
    });
  }

  async pushDirectory(localPath: string, destPath: string): Promise<void> {
    const dest = resolveHostPath(this.workspacePath, destPath);
    await mkdir(dest, { recursive: true });
    await cp(localPath, dest, { recursive: true });
  }

  async pullDirectory(srcPath: string, localPath: string): Promise<void> {
    await mkdir(localPath, { recursive: true });
    await cp(resolveHostPath(this.workspacePath, srcPath), localPath, { recursive: true });
  }

  async writeFile(path: string, contents: string): Promise<void> {
    const target = resolveHostPath(this.workspacePath, path);
    await mkdir(dirname(target), { recursive: true });
    await writeHostFile(target, contents, "utf8");
  }

  async readFile(path: string): Promise<string> {
    return readHostFile(resolveHostPath(this.workspacePath, path), "utf8");
  }

  async destroy(): Promise<void> {
    await rm(this.#rootDir, { recursive: true, force: true });
  }
}

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}
