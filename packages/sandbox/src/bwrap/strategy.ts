import { mkdir, mkdtemp, rm, writeFile as writeHostFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCommand } from "../exec.js";
import { resolveBinary } from "../host.js";
import type { SandboxStrategy } from "../provider.js";
import { SANDBOX_RESOLV_CONTENTS, SANDBOX_RESOLV_PATH, type SandboxTools, wrapInBwrap } from "./wrap.js";

/**
 * Problems that stop this host from running bwrap sandboxes. Empty means
 * `ensureAvailable` will succeed. Includes a production-shaped probe so
 * doctor, setup, and the provider share one readiness definition.
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

/**
 * Isolated execution via bubblewrap plus pasta. The workspace is a host
 * directory; every command runs inside user/pid/mount/net namespaces and can
 * see neither the operator's $HOME nor the host's loopback services.
 */
export const bwrapStrategy: SandboxStrategy = {
  name: "bwrap",
  label: "bwrap",
  // Chromium inside an existing user namespace cannot use its own sandbox.
  env: { PLAYWRIGHT_CHROMIUM_SANDBOX: "0" },
  collectProblems: collectBwrapProblems,
  async prepare(rootDir) {
    const tools = await requireSandboxTools();
    await ensureSandboxResolvConf();
    return (command, args, cwd, options) =>
      wrapInBwrap(tools, rootDir, command, args, cwd, {
        newSession: options.newSession,
        env: options.env,
      });
  },
};

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
