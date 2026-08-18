import { stat } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { BREVI_HOME, mergeUsageDays, parseCcusageDaily, type UsageDay } from "@brevi/shared";

/**
 * This machine's agent usage over time, read with `ccusage`'s daily reports.
 * Used on the host for its own row of the Usage page, and by `brevi worker`
 * (via the internal export) to answer the host's usage-report request for
 * each connected machine.
 */

/**
 * Find a working `ccusage` on this machine: PATH first, then a cache under
 * BREVI_HOME installed once so repeated reads never trigger a network fetch.
 * Same resolution the per-run sampler uses inside sandboxes (worker
 * ccusage.ts), but executed on the machine itself.
 */
async function resolveCcusage(): Promise<string | undefined> {
  try {
    const probe = await execa("ccusage", ["--version"], { timeout: 15_000 });
    if (probe.exitCode === 0) return "ccusage";
  } catch {
    // fall through to the cache below
  }

  const cacheDir = join(BREVI_HOME, "cache", "ccusage");
  const binPath = join(cacheDir, "node_modules", ".bin", "ccusage");
  try {
    await stat(binPath);
  } catch {
    try {
      await execa(
        "npm",
        ["install", "--prefix", cacheDir, "ccusage", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"],
        { timeout: 180_000 },
      );
    } catch {
      return undefined;
    }
  }

  try {
    const probe = await execa(binPath, ["--version"], { timeout: 15_000 });
    if (probe.exitCode === 0) return binPath;
  } catch {
    // fall through
  }
  return undefined;
}

/** One `ccusage <source> daily` read; any failure degrades to an empty list. */
async function dailyReport(command: string, source: "claude" | "codex"): Promise<UsageDay[]> {
  try {
    const result = await execa(command, [source, "daily", "--json", "--offline"], {
      timeout: 60_000,
    });
    if (result.exitCode !== 0) return [];
    return parseCcusageDaily(result.stdout, source);
  } catch {
    return [];
  }
}

/**
 * The machine's daily usage, Claude Code and Codex reads summed per day.
 * Throws only when no ccusage binary could be resolved at all; a read that
 * finds no transcripts simply returns an empty list.
 */
export async function readMachineUsage(): Promise<UsageDay[]> {
  const command = await resolveCcusage();
  if (!command) {
    throw new Error("ccusage is not available on this machine and installing it failed");
  }
  const [claude, codex] = await Promise.all([
    dailyReport(command, "claude"),
    dailyReport(command, "codex"),
  ]);
  return mergeUsageDays(claude, codex);
}
