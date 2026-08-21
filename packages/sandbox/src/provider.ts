import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { WORKSPACES_DIR } from "@brevi/shared";
import { runCommand } from "./exec.js";
import { copyDirIntoWithin, copyDirOutOfWithin, readFileWithin, writeFileWithin } from "./hostfs.js";
import { resolveHostPath } from "./paths.js";
import type {
  CreateSandboxOptions,
  ExecOptions,
  ExecResult,
  Sandbox,
  SandboxLaunch,
  SandboxProvider,
} from "./types.js";

/** Host variables kept for sandboxed commands unless overridden by the caller. */
const INHERITED_ENV_KEYS = ["PATH", "LANG", "LC_ALL", "SHELL", "TERM", "USER"];

/** Builds the argv that runs `command` inside one run's sandbox. */
export type SandboxWrap = (
  command: string,
  args: string[],
  cwd: string,
  options: { newSession: boolean; env: Record<string, string> },
) => SandboxLaunch;

/**
 * What actually differs between the platform sandboxes. Everything else
 * (workspace layout, env sanitizing, host-side file ops) is shared by
 * `PlatformSandboxProvider`/`PlatformSandbox`.
 */
export interface SandboxStrategy {
  readonly name: "bwrap" | "seatbelt";
  /** Human name used in availability errors ("bwrap", "Seatbelt"). */
  readonly label: string;
  /** Env entries forced into every sandboxed command (callers can still override). */
  readonly env?: Record<string, string>;
  /**
   * Seatbelt only: no PID namespace contains a run's processes, so each exec
   * leads its own process group and release()/destroy() reap every group.
   * bwrap gets this containment from its PID namespace.
   */
  readonly reapProcessGroups?: boolean;
  /** Problems that stop this host from running sandboxes. Empty means available. */
  collectProblems(): Promise<string[]>;
  /**
   * Per-run setup on create/rehydrate (resolve tools, write the profile);
   * returns the argv wrapper for this run.
   */
  prepare(rootDir: string): Promise<SandboxWrap>;
  /** Removes per-run state living beside the run root (Seatbelt's profile). */
  cleanup?(rootDir: string): Promise<void>;
}

/** The one concrete SandboxProvider, parameterized by a platform strategy. */
export class PlatformSandboxProvider implements SandboxProvider {
  readonly name: "bwrap" | "seatbelt";
  readonly #strategy: SandboxStrategy;

  constructor(strategy: SandboxStrategy) {
    this.#strategy = strategy;
    this.name = strategy.name;
  }

  async ensureAvailable(): Promise<void> {
    const problems = await this.#strategy.collectProblems();
    if (problems.length === 0) return;
    throw new Error(
      `The ${this.#strategy.label} sandbox cannot run on this host:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`,
    );
  }

  async create(options: CreateSandboxOptions): Promise<Sandbox> {
    const rootDir = join(WORKSPACES_DIR, options.id);
    await mkdir(join(rootDir, "workspace"), { recursive: true });
    return this.#boot(options, rootDir);
  }

  async rehydrate(options: CreateSandboxOptions): Promise<Sandbox> {
    const rootDir = join(WORKSPACES_DIR, options.id);
    try {
      await stat(join(rootDir, "workspace"));
    } catch {
      throw new Error(`no retained sandbox for ${options.id}`);
    }
    return this.#boot(options, rootDir);
  }

  async #boot(options: CreateSandboxOptions, rootDir: string): Promise<Sandbox> {
    await mkdir(join(rootDir, "home"), { recursive: true });
    const wrap = await this.#strategy.prepare(rootDir);
    return new PlatformSandbox(this.#strategy, options.id, rootDir, wrap, options.env ?? {});
  }

  async discard(id: string): Promise<void> {
    const rootDir = join(WORKSPACES_DIR, id);
    await rm(rootDir, { recursive: true, force: true });
    await this.#strategy.cleanup?.(rootDir);
  }
}

class PlatformSandbox implements Sandbox {
  readonly provider: "bwrap" | "seatbelt";
  readonly id: string;
  readonly workspacePath: string;
  readonly homePath: string;
  readonly #strategy: SandboxStrategy;
  readonly #rootDir: string;
  readonly #wrap: SandboxWrap;
  readonly #env: Record<string, string>;
  /**
   * Process-group leaders (one per exec), tracked only when the strategy has
   * no PID namespace to contain a run: a daemonized child would survive the
   * command that spawned it, so release()/destroy() kill every group.
   */
  readonly #groups = new Set<number>();

  constructor(
    strategy: SandboxStrategy,
    id: string,
    rootDir: string,
    wrap: SandboxWrap,
    env: Record<string, string>,
  ) {
    this.#strategy = strategy;
    this.provider = strategy.name;
    this.id = id;
    this.#rootDir = rootDir;
    this.workspacePath = join(rootDir, "workspace");
    this.homePath = join(rootDir, "home");
    this.#wrap = wrap;
    this.#env = env;
  }

  /** SIGKILL every recorded process group, reaping daemonized descendants. */
  #reapGroups(): void {
    for (const pid of this.#groups) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Group already gone; nothing to reap.
      }
    }
    this.#groups.clear();
  }

  wrap(
    command: string,
    args: string[],
    cwd?: string,
    options?: { newSession?: boolean; env?: Record<string, string> },
  ): SandboxLaunch {
    const env = sandboxEnv(this.homePath, this.#strategy.env, this.#env, options?.env);
    return this.#wrap(command, args, resolveHostPath(this.workspacePath, cwd), {
      newSession: options?.newSession ?? true,
      env,
    });
  }

  async exec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const env = sandboxEnv(this.homePath, this.#strategy.env, this.#env, options.env);
    const launch = this.#wrap(command, args, resolveHostPath(this.workspacePath, options.cwd), {
      newSession: true,
      env,
    });
    const runOptions = {
      env: launch.env,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
    };
    if (this.#strategy.reapProcessGroups !== true) return runCommand(launch.file, launch.args, runOptions);
    // Each exec leads its own process group. runCommand reaps that group when
    // the foreground command exits (killing daemonized descendants and
    // releasing the inherited pipes), so the tracked entry is removed here as
    // soon as exec returns. #groups therefore holds only groups of execs
    // still running, which is exactly what release()/destroy() must reap; a
    // completed pid is never left behind to collide with a reused group id.
    let pid: number | undefined;
    try {
      return await runCommand(launch.file, launch.args, {
        ...runOptions,
        detached: true,
        onSpawn: (spawned) => {
          pid = spawned;
          this.#groups.add(spawned);
        },
      });
    } finally {
      if (pid !== undefined) this.#groups.delete(pid);
    }
  }

  // File and directory ops below run on the host, outside the sandbox's
  // containment, against agent-controlled trees: every path is realpath'd and
  // must stay under the per-run root so a planted symlink cannot redirect a
  // read or write to host files (see hostfs.ts).

  async pushDirectory(localPath: string, destPath: string): Promise<void> {
    await copyDirIntoWithin(this.#rootDir, localPath, resolveHostPath(this.workspacePath, destPath));
  }

  async pullDirectory(srcPath: string, localPath: string): Promise<void> {
    await copyDirOutOfWithin(this.#rootDir, resolveHostPath(this.workspacePath, srcPath), localPath);
  }

  async writeFile(path: string, contents: string): Promise<void> {
    await writeFileWithin(this.#rootDir, resolveHostPath(this.workspacePath, path), contents);
  }

  async readFile(path: string): Promise<string> {
    return readFileWithin(this.#rootDir, resolveHostPath(this.workspacePath, path));
  }

  async release(): Promise<void> {
    // The workspace directory on the host IS the retained state. Seatbelt
    // leaves no PID namespace to stop compute, so reap any lingering groups;
    // for bwrap the set is always empty and this is a no-op.
    this.#reapGroups();
  }

  async destroy(): Promise<void> {
    this.#reapGroups();
    await rm(this.#rootDir, { recursive: true, force: true });
    await this.#strategy.cleanup?.(this.#rootDir);
  }
}

/**
 * Allowlisted host env plus HOME/TMPDIR for a sandboxed command. Attach and
 * exec both use this so the inner process never sees the worker's secrets.
 * HOME is the per-run home beside the checkout, never the checkout itself,
 * so agent session files and caches cannot land in the generated PR.
 */
export function sandboxEnv(
  homePath: string,
  platformEnv: Record<string, string> | undefined,
  provided: Record<string, string>,
  extra?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.HOME = homePath;
  env.TMPDIR = "/tmp";
  env.TERM ??= "xterm-256color";
  return { ...env, ...platformEnv, ...provided, ...extra };
}
