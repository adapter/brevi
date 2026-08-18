/**
 * Machine-level agent usage over time, as reported by `ccusage`'s daily
 * report on each machine (the host and every connected worker). Unlike the
 * per-run cost entries in types.ts, these figures cover everything ccusage
 * can see on the machine, whether or not brevi ran it.
 */

/** One model's share of a day, with the agent provider that produced it. */
export interface UsageModelUsage {
  /** "claude" | "codex" | future providers, from which ccusage read it came. */
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface UsageDay {
  /** Calendar day, "YYYY-MM-DD", as ccusage reports it (machine-local time). */
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Sum of ccusage's per-day cost figures; 0 when ccusage priced nothing. */
  costUsd: number;
  /** Per-model rows behind the day's totals; absent from reports older workers send. */
  models?: UsageModelUsage[];
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
export function parseCcusageDaily(stdout: string, provider: string): UsageDay[] {
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
    const costUsd = num(raw.totalCost ?? raw.costUSD ?? raw.cost);
    const models = parseModelRows(raw, provider);
    // The Codex report prices the day, not the model: its model entries are
    // tokens-only. When no row carries a cost but the day does, prorate the
    // day's cost by each model's share of its tokens; the common one-model
    // day gets the exact figure, and a multi-model day gets an estimate
    // rather than a table full of $0 rows.
    if (costUsd > 0 && models.length > 0 && models.every((m) => m.costUsd === 0)) {
      const weights = models.map(
        (m) => m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheWriteTokens,
      );
      const total = weights.reduce((a, b) => a + b, 0);
      if (total > 0) {
        models.forEach((m, i) => {
          m.costUsd = Math.round(((costUsd * (weights[i] ?? 0)) / total) * 1e6) / 1e6;
        });
      } else if (models.length === 1 && models[0]) {
        models[0].costUsd = costUsd;
      }
    }
    days.push({
      date: dateRaw,
      inputTokens: num(raw.inputTokens),
      outputTokens: num(raw.outputTokens),
      cacheReadTokens: num(raw.cacheReadTokens),
      cacheWriteTokens: num(raw.cacheCreationTokens ?? raw.cacheWriteTokens),
      costUsd,
      ...(models.length > 0 ? { models } : {}),
    });
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * A day's per-model rows. The Claude report carries a `modelBreakdowns`
 * array (modelName/cost); the Codex report has used both that shape and a
 * `models` dict keyed by model name, so both are accepted. A row set that
 * doesn't parse degrades to no breakdown, never to a dropped day.
 */
function parseModelRows(raw: Record<string, unknown>, provider: string): UsageModelUsage[] {
  const rows: UsageModelUsage[] = [];
  const breakdowns = raw.modelBreakdowns;
  if (Array.isArray(breakdowns)) {
    for (const entry of breakdowns) {
      if (!isDict(entry)) continue;
      const model = entry.modelName ?? entry.model;
      if (typeof model !== "string") continue;
      rows.push({
        provider,
        model,
        inputTokens: num(entry.inputTokens),
        outputTokens: num(entry.outputTokens),
        cacheReadTokens: num(entry.cacheReadTokens),
        cacheWriteTokens: num(entry.cacheCreationTokens ?? entry.cacheWriteTokens),
        costUsd: num(entry.cost ?? entry.costUSD ?? entry.totalCost),
      });
    }
    return rows;
  }
  const models = raw.models;
  if (isDict(models)) {
    for (const [model, entry] of Object.entries(models)) {
      if (!isDict(entry)) continue;
      rows.push({
        provider,
        model,
        inputTokens: num(entry.inputTokens),
        outputTokens: num(entry.outputTokens),
        cacheReadTokens: num(entry.cacheReadTokens),
        cacheWriteTokens: num(entry.cacheCreationTokens ?? entry.cacheWriteTokens),
        costUsd: num(entry.cost ?? entry.costUSD ?? entry.totalCost),
      });
    }
  }
  return rows;
}

/**
 * Sum per-model rows by (provider, model), descending by cost. Used when
 * merging a machine's reads and when the dashboard rolls a range up.
 */
export function mergeModelRows(...lists: UsageModelUsage[][]): UsageModelUsage[] {
  const byKey = new Map<string, UsageModelUsage>();
  for (const list of lists) {
    for (const row of list) {
      const key = `${row.provider}\n${row.model}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { ...row });
        continue;
      }
      existing.inputTokens += row.inputTokens;
      existing.outputTokens += row.outputTokens;
      existing.cacheReadTokens += row.cacheReadTokens;
      existing.cacheWriteTokens += row.cacheWriteTokens;
      existing.costUsd = Math.round((existing.costUsd + row.costUsd) * 1e6) / 1e6;
    }
  }
  return [...byKey.values()].sort((a, b) => b.costUsd - a.costUsd);
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
      const models = mergeModelRows(existing.models ?? [], day.models ?? []);
      if (models.length > 0) existing.models = models;
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
