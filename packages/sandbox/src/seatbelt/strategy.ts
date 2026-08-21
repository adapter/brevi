import { mkdir, mkdtemp, rm, stat, writeFile as writeHostFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BREVI_HOME } from "@brevi/shared";
import { runCommand } from "../exec.js";
import type { SandboxStrategy } from "../provider.js";
import { seatbeltPolicy } from "./policy.js";
import { SANDBOX_EXEC, wrapInSeatbelt } from "./wrap.js";

/**
 * Problems that stop this host from running Seatbelt sandboxes. Empty means
 * `ensureAvailable` will succeed. The probe runs a real profile and checks
 * both directions: an allowed command succeeds and a write outside the
 * allowed roots is denied.
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

/**
 * Isolated execution via macOS Seatbelt (`sandbox-exec`) with a per-run SBPL
 * profile. Policy-based confinement rather than Linux namespaces: writes are
 * limited to the run root and tmp, credential trees are unreadable, and the
 * process otherwise sees the real system. The weaker of the two sandboxes;
 * documented as such wherever the fleet surfaces it.
 */
export const seatbeltStrategy: SandboxStrategy = {
  name: "seatbelt",
  label: "Seatbelt",
  reapProcessGroups: true,
  collectProblems: collectSeatbeltProblems,
  async prepare(rootDir) {
    const profilePath = await writeProfile(rootDir);
    return (command, args, cwd, options) => wrapInSeatbelt(profilePath, command, args, cwd, options.env);
  },
  async cleanup(rootDir) {
    await rm(profilePathFor(rootDir), { force: true });
  },
};

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
