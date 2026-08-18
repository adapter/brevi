import { mkdir, mkdtemp, rm, stat, writeFile as writeHostFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BREVI_HOME, WORKSPACES_DIR } from "@brevi/shared";
import { runCommand } from "../exec.js";
import { copyDirIntoWithin, copyDirOutOfWithin, readFileWithin, writeFileWithin } from "../hostfs.js";
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
import { seatbeltPolicy } from "./policy.js";

/** Apple ships sandbox-exec here on every macOS; there is nothing to install. */
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Host variables kept for sandboxed commands unless overridden by the caller. */
const INHERITED_ENV_KEYS = ["PATH", "LANG", "LC_ALL", "SHELL", "TERM", "USER"];

/**
 * Problems that stop this host from running Seatbelt sandboxes. Empty means
 * `SeatbeltProvider.ensureAvailable` will succeed. The probe runs a real
 * profile and checks both directions: an allowed command succeeds and a
 * write outside the allowed roots is denied.
 */
export async function collectSeatbeltProblems(): Promise<string[]> {
  if (process.platform !== "darwin") {
    return [
      `Seatbelt sandboxes need macOS (this host is ${process.platform}); enroll a Linux worker to execute runs`,
    ];
  }
  try {
    await stat(SANDBOX_EXEC);
  } catch {
    return [`${SANDBOX_EXEC} was not found; it ships with macOS, so this install looks broken`];
  }
  const probe = await probeSeatbelt();
  return probe === undefined ? [] : [probe];
}

/** True when this host can run Seatbelt sandboxes. */
export async function seatbeltAvailable(): Promise<boolean> {
  return (await collectSeatbeltProblems()).length === 0;
}

/**
 * Isolated execution via macOS Seatbelt (`sandbox-exec`) with a per-run SBPL
 * profile. Policy-based confinement rather than Linux namespaces: writes are
 * limited to the run root and tmp, credential trees are unreadable, and the
 * process otherwise sees the real system. The weaker of the two providers;
 * documented as such wherever the fleet surfaces it.
 */
export class SeatbeltProvider implements SandboxProvider {
  readonly name = "seatbelt" as const;

  async ensureAvailable(): Promise<void> {
    const problems = await collectSeatbeltProblems();
    if (problems.length === 0) return;
    throw new Error(
      `The Seatbelt sandbox cannot run on this host:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`,
    );
  }

  async create(options: CreateSandboxOptions): Promise<Sandbox> {
    const rootDir = join(WORKSPACES_DIR, options.id);
    const workspacePath = join(rootDir, "workspace");
    const homePath = join(rootDir, "home");
    await mkdir(workspacePath, { recursive: true });
    await mkdir(homePath, { recursive: true });
    const profilePath = await writeProfile(rootDir);
    return new SeatbeltSandbox(options.id, rootDir, workspacePath, homePath, profilePath, options.env ?? {});
  }

  async rehydrate(options: CreateSandboxOptions): Promise<Sandbox> {
    const rootDir = join(WORKSPACES_DIR, options.id);
    const workspacePath = join(rootDir, "workspace");
    const homePath = join(rootDir, "home");
    try {
      await stat(workspacePath);
    } catch {
      throw new Error(`no retained sandbox for ${options.id}`);
    }
    await mkdir(homePath, { recursive: true });
    const profilePath = await writeProfile(rootDir);
    return new SeatbeltSandbox(options.id, rootDir, workspacePath, homePath, profilePath, options.env ?? {});
  }

  async discard(id: string): Promise<void> {
    await rm(join(WORKSPACES_DIR, id), { recursive: true, force: true });
    await rm(profilePathFor(join(WORKSPACES_DIR, id)), { force: true });
  }
}

/**
 * The profile lives beside the run root, not inside it: the run root is
 * writable from the sandbox, and a profile the sandbox could edit would let
 * the next exec grant itself anything.
 */
function profilePathFor(rootDir: string): string {
  return `${rootDir}.sb`;
}

async function writeProfile(rootDir: string): Promise<string> {
  const profilePath = profilePathFor(rootDir);
  await writeHostFile(profilePath, seatbeltPolicy({ rootDir }), "utf8");
  return profilePath;
}

class SeatbeltSandbox implements Sandbox {
  readonly provider = "seatbelt" as const;
  readonly id: string;
  readonly workspacePath: string;
  readonly homePath: string;
  readonly #rootDir: string;
  readonly #profilePath: string;
  readonly #env: Record<string, string>;
  // Process-group leaders (one per exec). Unlike bwrap's PID namespace,
  // Seatbelt does not contain a run's processes, so a daemonized child would
  // survive the command that spawned it. Each exec leads its own group and
  // release()/destroy() kill every group to reap those descendants.
  readonly #groups = new Set<number>();

  constructor(
    id: string,
    rootDir: string,
    workspacePath: string,
    homePath: string,
    profilePath: string,
    env: Record<string, string>,
  ) {
    this.id = id;
    this.#rootDir = rootDir;
    this.workspacePath = workspacePath;
    this.homePath = homePath;
    this.#profilePath = profilePath;
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

  wrap(command: string, args: string[], cwd?: string): SandboxLaunch {
    const env = sandboxEnv(this.homePath, this.#env);
    return wrapInSeatbelt(this.#profilePath, command, args, resolveHostPath(this.workspacePath, cwd), env);
  }

  async exec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const env = sandboxEnv(this.homePath, this.#env, options.env);
    const launch = wrapInSeatbelt(
      this.#profilePath,
      command,
      args,
      resolveHostPath(this.workspacePath, options.cwd),
      env,
    );
    // Each exec leads its own process group; a background process the agent
    // leaves running (a dev server for demo capture, say) stays up across
    // execs, exactly as under bwrap, and is reaped when the sandbox is
    // released or destroyed. The group is tracked, never killed per-exec.
    return runCommand(launch.file, launch.args, {
      env: launch.env,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
      detached: true,
      onSpawn: (pid) => this.#groups.add(pid),
    });
  }

  // File and directory ops below run on the host, outside the policy,
  // against agent-controlled trees: every path is realpath'd and must stay
  // under the per-run root so a planted symlink cannot redirect a read or
  // write to host files (see hostfs.ts).

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

  connection(): SandboxConnection {
    return { kind: "local", workspacePath: this.workspacePath };
  }

  async release(): Promise<void> {
    // The workspace directory on the host IS the retained state, but Seatbelt
    // leaves no PID namespace to stop compute, so reap any lingering groups.
    this.#reapGroups();
  }

  async destroy(): Promise<void> {
    this.#reapGroups();
    await rm(this.#rootDir, { recursive: true, force: true });
    await rm(this.#profilePath, { force: true });
  }
}

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

/**
 * Allowlisted host env plus HOME/TMPDIR for a sandboxed command, mirroring
 * the bwrap provider: HOME is the per-run home beside the checkout, never
 * the checkout itself, so agent session files cannot land in the PR.
 */
function sandboxEnv(
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
  return { ...env, ...provided, ...extra };
}

/**
 * Probe with a real profile: an allowed echo must succeed and a write
 * outside the allowed roots must fail. Returns a problem string, or
 * undefined when both hold.
 */
async function probeSeatbelt(): Promise<string | undefined> {
  const tmpRoot = await mkdtemp(join(tmpdir(), "brevi-seatbelt-probe-"));
  const profilePath = join(tmpRoot, "probe.sb");
  const insideDir = join(tmpRoot, "root");
  try {
    await mkdir(insideDir, { recursive: true });
    await writeHostFile(profilePath, seatbeltPolicy({ rootDir: insideDir }), "utf8");
    const env = { HOME: insideDir, TMPDIR: "/tmp", PATH: "/usr/bin:/bin", LANG: "C" };

    const allowed = await runCommand(
      SANDBOX_EXEC,
      ["-f", profilePath, "/bin/sh", "-c", `echo ok > ${JSON.stringify(join(insideDir, "probe.txt"))}`],
      { env, timeoutMs: 8_000 },
    );
    if (allowed.exitCode !== 0) {
      const detail = allowed.stderr.trim() || `exit ${allowed.exitCode}`;
      return `a sandbox-exec probe failed (${detail})`;
    }

    // A write under ~/.brevi (outside any run root, and outside the tmp
    // domains the policy always allows) must be denied. The probe profile
    // itself lives under /var/folders, which the policy deliberately allows,
    // so it cannot serve as the deny target.
    const deniedTarget = join(BREVI_HOME, `seatbelt-probe-denied-${Date.now()}`);
    const denied = await runCommand(
      SANDBOX_EXEC,
      ["-f", profilePath, "/bin/sh", "-c", `echo pwned > ${JSON.stringify(deniedTarget)}`],
      { env, timeoutMs: 8_000 },
    );
    if (denied.exitCode === 0) {
      await rm(deniedTarget, { force: true });
      return "the sandbox-exec probe was able to write outside its allowed roots; refusing to treat this policy as containment";
    }
    return undefined;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `a sandbox-exec probe failed (${detail})`;
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}
