import { rm } from "node:fs/promises";
import { dirname } from "node:path/posix";
import { execa } from "execa";
import { runCommand, runOrThrow } from "../exec.js";
import { resolveGuestPath } from "../paths.js";
import type { ExecOptions, ExecResult, Sandbox } from "../types.js";
import { quote, remoteCommandLine, sshArgs, type SshTarget } from "./ssh.js";
import type { MicroVm } from "./vm.js";

/** Where the run's checkout lives inside the guest. */
export const GUEST_WORKSPACE = "/workspace";

export async function ensureGuestWorkspace(target: SshTarget): Promise<void> {
  await runOrThrow("ssh", sshArgs(target, `mkdir -p ${quote(GUEST_WORKSPACE)}`));
}

/** Sandbox backed by a Firecracker microVM, driven entirely over ssh. */
export class FirecrackerSandbox implements Sandbox {
  readonly provider = "firecracker" as const;
  readonly workspacePath = GUEST_WORKSPACE;
  readonly id: string;
  readonly #vm: MicroVm;
  readonly #target: SshTarget;
  readonly #env: Record<string, string>;
  readonly #rootDir: string;

  constructor(init: {
    id: string;
    vm: MicroVm;
    target: SshTarget;
    env: Record<string, string>;
    rootDir: string;
  }) {
    this.id = init.id;
    this.#vm = init.vm;
    this.#target = init.target;
    this.#env = init.env;
    this.#rootDir = init.rootDir;
  }

  async exec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const remote = remoteCommandLine(
      resolveGuestPath(this.workspacePath, options.cwd),
      { ...this.#env, ...options.env },
      command,
      args,
    );
    return runCommand("ssh", sshArgs(this.#target, remote), {
      timeoutMs: options.timeoutMs,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
    });
  }

  async pushDirectory(localPath: string, destPath: string): Promise<void> {
    const dest = resolveGuestPath(this.workspacePath, destPath);
    const remote = `mkdir -p ${quote(dest)} && tar -C ${quote(dest)} -xf -`;
    try {
      await execa("tar", ["-C", localPath, "-cf", "-", "."], { buffer: false }).pipe(
        "ssh",
        sshArgs(this.#target, remote),
      );
    } catch (error) {
      throw new Error(`failed to push ${localPath} into the sandbox at ${dest}: ${reason(error)}`);
    }
  }

  async pullDirectory(srcPath: string, localPath: string): Promise<void> {
    const src = resolveGuestPath(this.workspacePath, srcPath);
    await runOrThrow("mkdir", ["-p", localPath]);
    try {
      await execa("ssh", sshArgs(this.#target, `tar -C ${quote(src)} -cf - .`), {
        buffer: false,
      }).pipe("tar", ["-C", localPath, "-xf", "-"]);
    } catch (error) {
      throw new Error(`failed to pull ${src} out of the sandbox to ${localPath}: ${reason(error)}`);
    }
  }

  async writeFile(path: string, contents: string): Promise<void> {
    const target = resolveGuestPath(this.workspacePath, path);
    const remote = `mkdir -p ${quote(dirname(target))} && cat > ${quote(target)}`;
    await runOrThrow("ssh", sshArgs(this.#target, remote), { input: contents });
  }

  async readFile(path: string): Promise<string> {
    const target = resolveGuestPath(this.workspacePath, path);
    // Bypasses runCommand so large files are not truncated by its capture cap.
    const result = await execa("ssh", sshArgs(this.#target, `cat ${quote(target)}`), {
      reject: false,
      stripFinalNewline: false,
    });
    if (result.exitCode !== 0) {
      throw new Error(`failed to read ${target} from the sandbox: ${result.stderr.trim()}`);
    }
    return result.stdout;
  }

  async destroy(): Promise<void> {
    await this.#vm.stop();
    await rm(this.#rootDir, { recursive: true, force: true });
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
