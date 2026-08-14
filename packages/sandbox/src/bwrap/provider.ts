import {
  cp,
  mkdir,
  mkdtemp,
  readFile as readHostFile,
  rm,
  stat,
  writeFile as writeHostFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WORKSPACES_DIR } from "@brevi/shared";
import { runCommand } from "../exec.js";
import { resolveBinary } from "../host.js";
import { resolveHostPath } from "../paths.js";
import type {
  CreateSandboxOptions,
  ExecOptions,
  ExecResult,
  Sandbox,
  SandboxConnection,
  SandboxLaunch,
  SandboxProvider,
} from "../types.js";
import { wrapInBwrap } from "./wrap.js";

/** Host variables kept for sandboxed commands unless overridden by the caller. */
const INHERITED_ENV_KEYS = ["PATH", "LANG", "LC_ALL", "SHELL", "TERM", "USER"];

/**
 * Problems that stop this host from running bwrap sandboxes. Empty means
 * `BwrapProvider.ensureAvailable` will succeed. Includes a production-shaped
 * probe so doctor, setup, and `bwrapAvailable` share one readiness definition.
 */
export async function collectBwrapProblems(): Promise<string[]> {
  const problems: string[] = [];
  if (process.platform !== "linux") {
    problems.push(
      `bwrap sandboxes need Linux (this host is ${process.platform}); enroll a Linux worker to execute runs`,
    );
    return problems;
  }
  const bwrap = await resolveBinary("bwrap");
  if (bwrap === undefined) {
    problems.push('the "bwrap" command was not found on PATH; install bubblewrap (apt install bubblewrap)');
    return problems;
  }
  const probe = await probeBwrap(bwrap);
  if (probe !== undefined) problems.push(probe);
  return problems;
}

/** True when this host can run bwrap sandboxes. */
export async function bwrapAvailable(): Promise<boolean> {
  return (await collectBwrapProblems()).length === 0;
}

/**
 * Isolated execution via bubblewrap. The workspace is a host directory;
 * every command runs inside a user/pid/mount namespace and cannot see the
 * operator's $HOME.
 */
export class BwrapProvider implements SandboxProvider {
  readonly name = "bwrap" as const;

  async ensureAvailable(): Promise<void> {
    const problems = await collectBwrapProblems();
    if (problems.length === 0) return;
    throw new Error(
      `The bwrap sandbox cannot run on this host:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`,
    );
  }

  async create(options: CreateSandboxOptions): Promise<Sandbox> {
    const bwrap = await requireBwrap();
    const rootDir = join(WORKSPACES_DIR, options.id);
    const workspacePath = join(rootDir, "workspace");
    const homePath = join(rootDir, "home");
    await mkdir(workspacePath, { recursive: true });
    await mkdir(homePath, { recursive: true });
    return new BwrapSandbox(options.id, rootDir, workspacePath, homePath, bwrap, options.env ?? {});
  }

  async rehydrate(options: CreateSandboxOptions): Promise<Sandbox> {
    const bwrap = await requireBwrap();
    const rootDir = join(WORKSPACES_DIR, options.id);
    const workspacePath = join(rootDir, "workspace");
    const homePath = join(rootDir, "home");
    try {
      await stat(workspacePath);
    } catch {
      throw new Error(`no retained sandbox for ${options.id}`);
    }
    await mkdir(homePath, { recursive: true });
    return new BwrapSandbox(options.id, rootDir, workspacePath, homePath, bwrap, options.env ?? {});
  }

  async discard(id: string): Promise<void> {
    await rm(join(WORKSPACES_DIR, id), { recursive: true, force: true });
  }
}

class BwrapSandbox implements Sandbox {
  readonly provider = "bwrap" as const;
  readonly id: string;
  readonly workspacePath: string;
  readonly homePath: string;
  readonly #rootDir: string;
  readonly #bwrap: string;
  readonly #env: Record<string, string>;

  constructor(
    id: string,
    rootDir: string,
    workspacePath: string,
    homePath: string,
    bwrap: string,
    env: Record<string, string>,
  ) {
    this.id = id;
    this.#rootDir = rootDir;
    this.workspacePath = workspacePath;
    this.homePath = homePath;
    this.#bwrap = bwrap;
    this.#env = env;
  }

  wrap(command: string, args: string[], cwd?: string, options?: { newSession?: boolean }): SandboxLaunch {
    const env = sandboxEnv(this.homePath, this.#env);
    return wrapInBwrap(this.#bwrap, this.#rootDir, command, args, resolveHostPath(this.workspacePath, cwd), {
      newSession: options?.newSession ?? true,
      env,
    });
  }

  async exec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const env = sandboxEnv(this.homePath, this.#env, options.env);
    const launch = wrapInBwrap(
      this.#bwrap,
      this.#rootDir,
      command,
      args,
      resolveHostPath(this.workspacePath, options.cwd),
      { newSession: true, env },
    );
    return runCommand(launch.file, launch.args, {
      env: launch.env,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
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

  connection(): SandboxConnection {
    return { kind: "local", workspacePath: this.workspacePath };
  }

  async release(): Promise<void> {
    // No-op: the workspace directory on the host IS the retained state.
  }

  async destroy(): Promise<void> {
    await rm(this.#rootDir, { recursive: true, force: true });
  }
}

async function requireBwrap(): Promise<string> {
  const bwrap = await resolveBinary("bwrap");
  if (bwrap === undefined) {
    throw new Error('the "bwrap" command was not found on PATH; install bubblewrap (apt install bubblewrap)');
  }
  return bwrap;
}

/**
 * Probe with the same wrap a real exec uses, not just `--unshare-user --unshare-pid`.
 * Returns a problem string, or undefined when the probe succeeds.
 */
async function probeBwrap(bwrap: string): Promise<string | undefined> {
  const tmpRoot = await mkdtemp(join(tmpdir(), "brevi-bwrap-probe-"));
  try {
    const env = { HOME: tmpRoot, TMPDIR: "/tmp", PATH: "/usr/bin:/bin", LANG: "C" };
    const launch = wrapInBwrap(bwrap, tmpRoot, "true", [], tmpRoot, { newSession: true, env });
    const result = await runCommand(launch.file, launch.args, { timeoutMs: 8_000 });
    if (result.exitCode === 0) return undefined;
    const detail = result.stderr.trim() || `exit ${result.exitCode}`;
    return `unprivileged user namespaces are disabled or bwrap failed a probe (${detail}); enable kernel.unprivileged_userns_clone=1 or check AppArmor`;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `unprivileged user namespaces are disabled or bwrap failed a probe (${detail}); enable kernel.unprivileged_userns_clone=1 or check AppArmor`;
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

/**
 * Allowlisted host env plus HOME/TMPDIR for a sandboxed command. Attach and
 * exec both use this so the inner process never sees the worker's secrets.
 * HOME is the per-run home beside the checkout, never the checkout itself,
 * so Claude session files and npm caches cannot land in the generated PR.
 */
export function sandboxEnv(
  homePath: string,
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
  // Chromium inside an existing user namespace cannot use its own sandbox.
  env.PLAYWRIGHT_CHROMIUM_SANDBOX = "0";
  return { ...env, ...provided, ...extra };
}
