/**
 * Machine-level agent usage over time, as reported by `ccusage`'s daily
 * report on each machine (the host and every connected worker). Unlike the
 * per-run cost entries in types.ts, these figures cover everything ccusage
 * can see on the machine, whether or not brevi ran it.
 */

export interface UsageDay {
  /** Calendar day, "YYYY-MM-DD", as ccusage reports it (machine-local time). */
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Sum of ccusage's per-day cost figures; 0 when ccusage priced nothing. */
  costUsd: number;
}

/** One machine's slice of the usage report. */
export interface MachineUsage {
  /** Worker id, or "host" for the machine Mission Control runs on. */
  id: string;
  name: string;
  /** Days with any usage, ascending by date. Empty when the read found nothing. */
  days: UsageDay[];
  /** Why the machine has no report (offline worker, ccusage unavailable, timeout). */
  error?: string;
}

/** Body of GET /api/usage. */
export interface UsageResponse {
  machines: MachineUsage[];
  /** When the orchestrator collected the report (it may serve a recent cache). */
  collectedAt: string;
}

const isDict = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Tolerant parse of a `ccusage <claude|codex> daily --json` report. Field
 * names are matched with fallbacks ("totalCost"/"costUSD"/"cost",
 * "cacheCreationTokens" for what our schema calls cacheWriteTokens), so a
 * ccusage version drift degrades to fewer figures rather than an empty read.
 * Rows without a parsable date are dropped; rows are returned ascending.
 */
export function parseCcusageDaily(stdout: string): UsageDay[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!isDict(data)) return [];
  const rows = data.daily ?? data.days;
  if (!Array.isArray(rows)) return [];

  const days: UsageDay[] = [];
  for (const raw of rows) {
    if (!isDict(raw)) continue;
    const dateRaw = raw.date ?? raw.day;
    if (typeof dateRaw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) continue;
    days.push({
      date: dateRaw,
      inputTokens: num(raw.inputTokens),
      outputTokens: num(raw.outputTokens),
      cacheReadTokens: num(raw.cacheReadTokens),
      cacheWriteTokens: num(raw.cacheCreationTokens ?? raw.cacheWriteTokens),
      costUsd: num(raw.totalCost ?? raw.costUSD ?? raw.cost),
    });
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Sum several daily reports (e.g. a machine's Claude and Codex reads) into
 * one list keyed by date, ascending. Days that end up all-zero are kept:
 * a zero row only exists because some source reported the day.
 */
export function mergeUsageDays(...lists: UsageDay[][]): UsageDay[] {
  const byDate = new Map<string, UsageDay>();
  for (const list of lists) {
    for (const day of list) {
      const existing = byDate.get(day.date);
      if (!existing) {
        byDate.set(day.date, { ...day });
        continue;
      }
      existing.inputTokens += day.inputTokens;
      existing.outputTokens += day.outputTokens;
      existing.cacheReadTokens += day.cacheReadTokens;
      existing.cacheWriteTokens += day.cacheWriteTokens;
      existing.costUsd = Math.round((existing.costUsd + day.costUsd) * 1e6) / 1e6;
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
