import { cp, mkdir, mkdtemp, rm, stat, writeFile as writeHostFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WORKSPACES_DIR } from "@brevi/shared";
import { runCommand } from "../exec.js";
import { resolveBinary } from "../host.js";
import { ensureDirWithin, readFileWithin, resolveDirWithin, writeFileWithin } from "../hostfs.js";
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
import { SANDBOX_RESOLV_CONTENTS, SANDBOX_RESOLV_PATH, type SandboxTools, wrapInBwrap } from "./wrap.js";

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
  }
  const pasta = await resolveBinary("pasta");
  if (pasta === undefined) {
    problems.push('the "pasta" command was not found on PATH; install passt (apt install passt)');
  }
  if (bwrap === undefined || pasta === undefined) return problems;
  const probe = await probeBwrap({ bwrap, pasta });
  if (probe !== undefined) problems.push(probe);
  return problems;
}

/** True when this host can run bwrap sandboxes. */
export async function bwrapAvailable(): Promise<boolean> {
  return (await collectBwrapProblems()).length === 0;
}

/**
 * Isolated execution via bubblewrap plus pasta. The workspace is a host
 * directory; every command runs inside user/pid/mount/net namespaces and can
 * see neither the operator's $HOME nor the host's loopback services.
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
    const tools = await requireSandboxTools();
    const rootDir = join(WORKSPACES_DIR, options.id);
    const workspacePath = join(rootDir, "workspace");
    const homePath = join(rootDir, "home");
    await mkdir(workspacePath, { recursive: true });
    await mkdir(homePath, { recursive: true });
    await ensureSandboxResolvConf();
    return new BwrapSandbox(options.id, rootDir, workspacePath, homePath, tools, options.env ?? {});
  }

  async rehydrate(options: CreateSandboxOptions): Promise<Sandbox> {
    const tools = await requireSandboxTools();
    const rootDir = join(WORKSPACES_DIR, options.id);
    const workspacePath = join(rootDir, "workspace");
    const homePath = join(rootDir, "home");
    try {
      await stat(workspacePath);
    } catch {
      throw new Error(`no retained sandbox for ${options.id}`);
    }
    await mkdir(homePath, { recursive: true });
    await ensureSandboxResolvConf();
    return new BwrapSandbox(options.id, rootDir, workspacePath, homePath, tools, options.env ?? {});
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
  readonly #tools: SandboxTools;
  readonly #env: Record<string, string>;

  constructor(
    id: string,
    rootDir: string,
    workspacePath: string,
    homePath: string,
    tools: SandboxTools,
    env: Record<string, string>,
  ) {
    this.id = id;
    this.#rootDir = rootDir;
    this.workspacePath = workspacePath;
    this.homePath = homePath;
    this.#tools = tools;
    this.#env = env;
  }

  wrap(command: string, args: string[], cwd?: string, options?: { newSession?: boolean }): SandboxLaunch {
    const env = sandboxEnv(this.homePath, this.#env);
    return wrapInBwrap(this.#tools, this.#rootDir, command, args, resolveHostPath(this.workspacePath, cwd), {
      newSession: options?.newSession ?? true,
      env,
    });
  }

  async exec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const env = sandboxEnv(this.homePath, this.#env, options.env);
    const launch = wrapInBwrap(
      this.#tools,
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

  // File and directory ops below run on the host, outside the mount
  // namespace, against agent-controlled trees: every path is realpath'd and
  // must stay under the per-run root so a planted symlink cannot redirect a
  // read or write to host files (see hostfs.ts).

  async pushDirectory(localPath: string, destPath: string): Promise<void> {
    const dest = await ensureDirWithin(this.#rootDir, resolveHostPath(this.workspacePath, destPath));
    await cp(localPath, dest, { recursive: true });
  }

  async pullDirectory(srcPath: string, localPath: string): Promise<void> {
    const src = await resolveDirWithin(this.#rootDir, resolveHostPath(this.workspacePath, srcPath));
    await mkdir(localPath, { recursive: true });
    await cp(src, localPath, { recursive: true });
  }

  async writeFile(path: string, contents: string): Promise<void> {
    await writeFileWithin(this.#rootDir, resolveHostPath(this.workspacePath, path), contents);
  }

  async readFile(path: string): Promise<string> {
    return readFileWithin(this.#rootDir, resolveHostPath(this.workspacePath, path));
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

async function requireSandboxTools(): Promise<SandboxTools> {
  const bwrap = await resolveBinary("bwrap");
  if (bwrap === undefined) {
    throw new Error('the "bwrap" command was not found on PATH; install bubblewrap (apt install bubblewrap)');
  }
  const pasta = await resolveBinary("pasta");
  if (pasta === undefined) {
    throw new Error('the "pasta" command was not found on PATH; install passt (apt install passt)');
  }
  return { bwrap, pasta };
}

/**
 * The resolv.conf bound over /etc/resolv.conf in every sandbox. Written
 * host-side under ~/.brevi, where the agent cannot touch it.
 */
async function ensureSandboxResolvConf(): Promise<void> {
  await mkdir(dirname(SANDBOX_RESOLV_PATH), { recursive: true });
  await writeHostFile(SANDBOX_RESOLV_PATH, SANDBOX_RESOLV_CONTENTS, "utf8");
}

/**
 * Probe with the same wrap a real exec uses (pasta netns included), not just
 * `--unshare-user --unshare-pid`. Returns a problem string, or undefined when
 * the probe succeeds.
 */
async function probeBwrap(tools: SandboxTools): Promise<string | undefined> {
  const tmpRoot = await mkdtemp(join(tmpdir(), "brevi-bwrap-probe-"));
  try {
    await writeHostFile(join(tmpRoot, "resolv.conf"), SANDBOX_RESOLV_CONTENTS, "utf8");
    const env = { HOME: tmpRoot, TMPDIR: "/tmp", PATH: "/usr/bin:/bin", LANG: "C" };
    const launch = wrapInBwrap(tools, tmpRoot, "true", [], tmpRoot, {
      newSession: true,
      env,
      resolvConfPath: join(tmpRoot, "resolv.conf"),
    });
    const result = await runCommand(launch.file, launch.args, { timeoutMs: 8_000 });
    if (result.exitCode === 0) return undefined;
    const detail = result.stderr.trim() || `exit ${result.exitCode}`;
    return `unprivileged user namespaces are disabled or a bwrap/pasta probe failed (${detail}); enable kernel.unprivileged_userns_clone=1 or check AppArmor`;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `unprivileged user namespaces are disabled or a bwrap/pasta probe failed (${detail}); enable kernel.unprivileged_userns_clone=1 or check AppArmor`;
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
