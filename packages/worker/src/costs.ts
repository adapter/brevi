import type { CostEntry, CostModelUsage } from "@brevi/shared";

/**
 * Reduces a coding agent's raw stream-json events into one CostEntry per
 * execution. Each provider (Claude, Codex, ...) gets a thin EventAdapter that
 * reduces its own event shapes to a NormalizedReading: per-model samples plus
 * an optional provider-reported execution total. usageCollector itself is
 * provider-agnostic, dispatching to the adapter registered for the requested
 * provider and handing whatever it observed to buildCostEntry, the one place
 * cost entries are assembled: ccusage transcript samples (ccusage.ts) feed the
 * same function, so roll-up, pricing fallback, and estimated-flag semantics
 * live here regardless of where the usage was measured. Adding a new coding
 * agent means adding one adapter to ADAPTERS; nothing else changes. Tolerant
 * of shapes it doesn't recognize (newer CLI versions, partial/malformed
 * events): unrecognized events are ignored rather than thrown on, since usage
 * capture must never break a run.
 */

const isDict = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Token usage accumulated so far, before cost is attached. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Present only once a cache-read figure has actually been observed. */
  cacheReadTokens?: number;
  /** Present only once a cache-write figure has actually been observed. */
  cacheWriteTokens?: number;
}

/**
 * One model's normalized contribution to an execution: the shape every usage
 * source (stream adapters, ccusage samples) reduces to before entries are
 * built.
 */
export interface NormalizedSample extends Usage {
  /** Model that produced the usage, when the source names one. */
  model?: string;
  /** Cost the source itself reported for this share; absent when only tokens are known. */
  costUsd?: number;
}

/** A provider adapter's normalized reading of the usage observed so far. */
interface NormalizedReading {
  /** Per-model contributions observed so far. */
  samples: NormalizedSample[];
  /**
   * Authoritative execution-wide token totals, when the provider reports one
   * (Claude's terminal "result" event); overrides the summed samples.
   */
  totalUsage?: Usage;
  /** Cost reported by the provider for the whole execution; absent when it never reports one. */
  totalCostUsd?: number;
  /** Headline model of the execution (Claude's init event); samples may add more (subagents). */
  model?: string;
}

/** Reduces one provider's raw stream events to a normalized usage reading. */
interface EventAdapter {
  observe(event: unknown): void;
  sessionId(): string | undefined;
  /** The normalized reading so far, or undefined if nothing was observed. */
  usage(): NormalizedReading | undefined;
}

export interface UsageCollector {
  observe(event: unknown): void;
  /** The session id observed so far (Claude's session_id or Codex's thread_id/session_id), or undefined. */
  sessionId(): string | undefined;
  /** One CostEntry for the execution so far, or undefined if nothing was observed. */
  snapshot(options: {
    label: string;
    subscription: boolean;
    /** Used when no model id was ever observed on the stream, e.g. Codex's new event format never names one. */
    fallbackModel?: string;
  }): CostEntry | undefined;
}

/**
 * Best-effort USD-per-million-token pricing, used only when the source
 * itself doesn't report a cost: always for Codex (the CLI never reports
 * spend), and for Claude when a run crashes before its terminal "result"
 * event or is running on a subscription login (nothing is actually billed
 * per token, so the figure is modeled rather than real). Matched by the
 * first substring of the model id that hits, in this order, so more specific
 * ids (gpt-5-nano, gpt-5-mini) are checked before the broader "gpt-5" prefix
 * that also covers gpt-5-codex and other gpt-5.x variants. These are
 * approximate list prices and will drift from a provider's actual billing;
 * they exist only to give a ballpark, not an invoice.
 */
const PRICING_TABLE: Array<{
  substring: string;
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** USD per million cache-read tokens, when the provider distinguishes them. */
  cacheRead?: number;
  /** USD per million cache-write tokens, when the provider distinguishes them. */
  cacheWrite?: number;
}> = [
  { substring: "claude-fable", input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  { substring: "claude-mythos", input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  { substring: "claude-opus", input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { substring: "claude-sonnet", input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { substring: "claude-haiku", input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  { substring: "gpt-5-nano", input: 0.05, output: 0.4, cacheRead: 0.005 },
  { substring: "gpt-5-mini", input: 0.25, output: 2.0, cacheRead: 0.025 },
  { substring: "gpt-5", input: 1.25, output: 10, cacheRead: 0.125 },
];

/** Round to 6 decimals: enough precision for micro-costs without float noise. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Estimate a USD cost from the pricing table; undefined when the model isn't in it. */
function estimateCost(usage: Usage, model: string | undefined): number | undefined {
  if (!model) return undefined;
  const price = PRICING_TABLE.find((row) => model.includes(row.substring));
  if (!price) return undefined;
  const cost =
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      (usage.cacheReadTokens ?? 0) * (price.cacheRead ?? 0) +
      (usage.cacheWriteTokens ?? 0) * (price.cacheWrite ?? 0)) /
    1_000_000;
  return round6(cost);
}

/** Merge one usage reading into a running total, keeping "never seen" distinct from zero. */
function accumulate(acc: Usage, usage: Usage): Usage {
  return {
    inputTokens: acc.inputTokens + usage.inputTokens,
    outputTokens: acc.outputTokens + usage.outputTokens,
    cacheReadTokens:
      usage.cacheReadTokens !== undefined ? (acc.cacheReadTokens ?? 0) + usage.cacheReadTokens : acc.cacheReadTokens,
    cacheWriteTokens:
      usage.cacheWriteTokens !== undefined
        ? (acc.cacheWriteTokens ?? 0) + usage.cacheWriteTokens
        : acc.cacheWriteTokens,
  };
}

/**
 * The one place cost entries are assembled, shared by every usage source:
 * stream adapters hand their reading over via usageCollector.snapshot, and
 * ccusage transcript samples come in through ccusageCostEntry (ccusage.ts).
 *
 * Samples are merged per model (unnamed samples fall to the execution's
 * model when one is known). The entry's top-level figures are the roll-up:
 * the provider-reported execution totals when present, else the summed
 * samples. An execution that spanned several models also carries the merged
 * rows as `breakdown`, so the per-model split survives into the run's
 * byModel aggregation (summarizeCosts) without double counting: consumers
 * read the breakdown instead of, never in addition to, the top-level
 * figures. Cost precedence: the provider's execution-wide figure, else the
 * sum of sample costs, else a pricing-table estimate (marked estimated, as
 * is any figure on a subscription login where nothing is billed per token).
 */
export function buildCostEntry(options: {
  label: string;
  provider: string;
  subscription: boolean;
  samples: NormalizedSample[];
  totalUsage?: Usage;
  totalCostUsd?: number;
  model?: string;
  fallbackModel?: string;
}): CostEntry {
  const { label, provider, subscription, samples, totalUsage, totalCostUsd, model, fallbackModel } = options;

  // Merge samples per model so several readings for one model still yield one
  // row. A sample without a model is attributed to the execution's own model
  // when one is known: it has no other plausible owner.
  const defaultModel = model ?? fallbackModel;
  const merged = new Map<string | undefined, NormalizedSample>();
  for (const sample of samples) {
    const key = sample.model ?? defaultModel;
    const existing = merged.get(key);
    if (!existing) {
      const row: NormalizedSample = { ...sample };
      if (key !== undefined) row.model = key;
      merged.set(key, row);
      continue;
    }
    const summed = accumulate(existing, sample);
    existing.inputTokens = summed.inputTokens;
    existing.outputTokens = summed.outputTokens;
    if (summed.cacheReadTokens !== undefined) existing.cacheReadTokens = summed.cacheReadTokens;
    if (summed.cacheWriteTokens !== undefined) existing.cacheWriteTokens = summed.cacheWriteTokens;
    if (sample.costUsd !== undefined) existing.costUsd = (existing.costUsd ?? 0) + sample.costUsd;
  }
  const rows = [...merged.values()];

  let summed: Usage = { inputTokens: 0, outputTokens: 0 };
  let rowCostUsd: number | undefined;
  // The row driving the reported `model` when the provider never named an
  // execution-wide one: highest-cost row when any row has a cost, else the
  // row with the most total tokens.
  let bestRow: NormalizedSample | undefined;
  for (const row of rows) {
    summed = accumulate(summed, row);
    if (row.costUsd !== undefined) rowCostUsd = (rowCostUsd ?? 0) + row.costUsd;
    if (bestRow === undefined) {
      bestRow = row;
      continue;
    }
    const better =
      row.costUsd !== undefined || bestRow.costUsd !== undefined
        ? (row.costUsd ?? -1) > (bestRow.costUsd ?? -1)
        : row.inputTokens + row.outputTokens > bestRow.inputTokens + bestRow.outputTokens;
    if (better) bestRow = row;
  }

  // Fill per-row cost gaps from the pricing table. A provider can price some of
  // an execution's models and not others (ccusage prices only what its bundled
  // data covers), and the roll-up below reports whatever the rows carry, so an
  // unpriced row would silently drop its share of the execution's cost. Gaps
  // only: a reported figure still wins wherever there is one. When no row was
  // priced at all this does nothing, leaving the whole-entry estimate below as
  // the single fallback path it has always been.
  let estimatedRow = false;
  if (rowCostUsd !== undefined) {
    for (const row of rows) {
      if (row.costUsd !== undefined) continue;
      const cost = estimateCost(row, row.model);
      if (cost === undefined) continue;
      row.costUsd = cost;
      rowCostUsd += cost;
      estimatedRow = true;
    }
  }

  const usage = totalUsage ?? summed;
  const resolvedModel = model ?? bestRow?.model ?? fallbackModel;

  const entry: CostEntry = {
    label,
    provider,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
  if (resolvedModel) entry.model = resolvedModel;
  if (usage.cacheReadTokens !== undefined) entry.cacheReadTokens = usage.cacheReadTokens;
  if (usage.cacheWriteTokens !== undefined) entry.cacheWriteTokens = usage.cacheWriteTokens;

  // Only a genuinely multi-model execution carries a breakdown; single-model
  // entries stay flat, their top-level figures being the only row. Rows that
  // could not be attributed to any model would leave the breakdown summing
  // short of the entry, so their presence suppresses it.
  if (rows.length >= 2 && rows.every((row) => row.model !== undefined)) {
    entry.breakdown = rows as CostModelUsage[];
  }

  const reportedCostUsd = totalCostUsd ?? rowCostUsd;
  if (reportedCostUsd !== undefined) {
    entry.costUsd = round6(reportedCostUsd);
    // Nothing is actually billed per token on a subscription login; the
    // reported figure is still a modeled cost, not a real charge. A figure
    // that is part reported and part priced from the table is modeled too.
    if (subscription || estimatedRow) entry.estimated = true;
  } else {
    // No source reported a cost, or none did this time (crash, usage limit):
    // fall back to the pricing table, pricing each model's share at its own
    // rate. The estimate lands on the row too (no row carried a cost, or the
    // reported branch above would have run), so the entry's figure stays
    // exactly the sum of its breakdown rows.
    let estimated: number | undefined;
    for (const row of rows) {
      const cost = estimateCost(row, row.model);
      if (cost !== undefined) {
        estimated = (estimated ?? 0) + cost;
        row.costUsd = cost;
      }
    }
    if (estimated === undefined && rows.length === 0) estimated = estimateCost(usage, resolvedModel);
    if (estimated !== undefined) entry.costUsd = round6(estimated);
    entry.estimated = true;
  }
  return entry;
}

/**
 * Parse a Claude Code `usage` object (from an "assistant" message or the
 * terminal "result" event). input_tokens excludes cache tokens on Claude;
 * they're reported separately.
 */
function claudeUsageFrom(raw: unknown): Usage | undefined {
  if (!isDict(raw)) return undefined;
  const input = raw.input_tokens;
  const output = raw.output_tokens;
  if (typeof input !== "number" && typeof output !== "number") return undefined;
  const usage: Usage = {
    inputTokens: typeof input === "number" ? input : 0,
    outputTokens: typeof output === "number" ? output : 0,
  };
  if (typeof raw.cache_read_input_tokens === "number") usage.cacheReadTokens = raw.cache_read_input_tokens;
  if (typeof raw.cache_creation_input_tokens === "number") usage.cacheWriteTokens = raw.cache_creation_input_tokens;
  return usage;
}

/**
 * Parse a Claude Agent SDK / recent Claude Code CLI `modelUsage` object (from
 * the terminal "result" event): `Record<modelId, ModelUsage>` covering the
 * main loop, Task subagents, and sidechains, so it is the authoritative
 * per-model split whenever it's present. Field names differ from our
 * internal Usage shape (camelCase, `cacheReadInputTokens` /
 * `cacheCreationInputTokens`) and from claudeUsageFrom's snake_case. Entries
 * that aren't dicts are skipped rather than aborting the whole parse, so one
 * malformed model doesn't drop the others. `costUSD` of exactly 0 means the
 * model was missing from the SDK's own pricing data, not that it was free;
 * taking that zero would make it beat buildCostEntry's pricing-table estimate
 * downstream, so only a positive finite figure counts as known (same guard
 * parseCcusageSessions applies in ccusage.ts).
 */
function claudeModelUsageFrom(raw: unknown): NormalizedSample[] {
  if (!isDict(raw)) return [];
  const samples: NormalizedSample[] = [];
  for (const [model, entry] of Object.entries(raw)) {
    if (!isDict(entry)) continue;
    const input = entry.inputTokens;
    const output = entry.outputTokens;
    const sample: NormalizedSample = {
      model,
      inputTokens: typeof input === "number" ? input : 0,
      outputTokens: typeof output === "number" ? output : 0,
    };
    if (typeof entry.cacheReadInputTokens === "number") sample.cacheReadTokens = entry.cacheReadInputTokens;
    if (typeof entry.cacheCreationInputTokens === "number") sample.cacheWriteTokens = entry.cacheCreationInputTokens;
    const costRaw = entry.costUSD;
    if (typeof costRaw === "number" && Number.isFinite(costRaw) && costRaw > 0) sample.costUsd = costRaw;
    samples.push(sample);
  }
  return samples;
}

/**
 * Parse a Codex usage object: either the old `token_count` event (`msg`'s own
 * fields, or newer 0.x CLIs' `info.total_token_usage`, cumulative for the
 * session) or the new `turn.completed` event's `usage` object (per-turn, same
 * field names). Codex's input_tokens includes cached tokens, unlike Claude,
 * so the cached portion is subtracted back out to get a fresh-token figure
 * comparable to Claude's input_tokens. output_tokens already includes
 * reasoning tokens.
 */
function codexUsageFrom(raw: unknown): Usage | undefined {
  if (!isDict(raw)) return undefined;
  const input = raw.input_tokens;
  const output = raw.output_tokens;
  if (typeof input !== "number" && typeof output !== "number") return undefined;
  const cached = raw.cached_input_tokens;
  const cachedTokens = typeof cached === "number" ? cached : 0;
  const usage: Usage = {
    inputTokens: Math.max(0, (typeof input === "number" ? input : 0) - cachedTokens),
    outputTokens: typeof output === "number" ? output : 0,
  };
  if (typeof cached === "number") usage.cacheReadTokens = cached;
  return usage;
}

/**
 * Claude Code's stream-json events: headline model and session id from the
 * "system"/"init" event; per-message fallback accumulation from every
 * "assistant" event keyed by that event's own model (so delegated executions
 * keep one contribution per model: orchestrator loop and implementer
 * subagent stay distinct); and the terminal "result" event supplying the
 * authoritative execution-wide totals when it arrives, plus (on the Claude
 * Agent SDK and recent CLIs) a `modelUsage` per-model split that overrides
 * the assistant-event accumulation whenever it's present.
 */
function claudeStreamAdapter(): EventAdapter {
  let mainModel: string | undefined;
  let sessionId: string | undefined;

  // Per-message accumulation from every "assistant" event, including subagent
  // messages, keyed by the model on each event. The per-model split fallback,
  // used only when the terminal "result" event never arrives (crash, usage
  // limit) or arrives without a usable modelUsage (older CLIs).
  const perModel = new Map<string | undefined, Usage>();

  // Terminal "result" event: its execution-wide usage and cost are
  // authoritative when present, overriding the accumulated totals above.
  // modelUsage, when it carries at least one row, is likewise authoritative
  // for the per-model split, overriding the assistant-event accumulation.
  let result: { usage: Usage | undefined; costUsd: number | undefined; modelUsage: NormalizedSample[] } | undefined;

  return {
    observe(event: unknown): void {
      if (!isDict(event)) return;
      if (event.type === "system" && event.subtype === "init") {
        if (typeof event.model === "string") mainModel ??= event.model;
        if (typeof event.session_id === "string") sessionId ??= event.session_id;
        return;
      }
      if (event.type === "assistant") {
        const message = event.message;
        if (isDict(message)) {
          const model = typeof message.model === "string" ? message.model : undefined;
          if (model) mainModel ??= model;
          const usage = claudeUsageFrom(message.usage);
          if (usage) {
            perModel.set(model, accumulate(perModel.get(model) ?? { inputTokens: 0, outputTokens: 0 }, usage));
          }
        }
        return;
      }
      if (event.type === "result") {
        result = {
          usage: claudeUsageFrom(event.usage),
          costUsd: typeof event.total_cost_usd === "number" ? event.total_cost_usd : undefined,
          modelUsage: claudeModelUsageFrom(event.modelUsage),
        };
        return;
      }
    },
    sessionId(): string | undefined {
      return sessionId;
    },
    usage(): NormalizedReading | undefined {
      if (!result && perModel.size === 0) return undefined;
      // The result event's modelUsage, when it carries at least one row, is
      // the authoritative per-model split (main loop, Task subagents, and
      // sidechains all covered); otherwise fall back to the assistant-event
      // accumulation, the only source when a run crashes before "result".
      const samples: NormalizedSample[] =
        result && result.modelUsage.length > 0
          ? result.modelUsage
          : [...perModel.entries()].map(([model, usage]) => {
              const sample: NormalizedSample = { ...usage };
              if (model) sample.model = model;
              return sample;
            });
      const reading: NormalizedReading = { samples };
      // A result without a recognized usage object leaves the accumulated
      // samples as the totals instead of zeroing the token counts.
      if (result?.usage) reading.totalUsage = result.usage;
      if (result && result.costUsd !== undefined) reading.totalCostUsd = result.costUsd;
      if (mainModel) reading.model = mainModel;
      return reading;
    },
  };
}

/**
 * Codex's stream-json events. Session id from `thread.started` (new format)
 * or `session_configured` (old envelopes), model from `session_configured`.
 * Codex reports a cumulative session total on every token_count event, so
 * each observation replaces the running total rather than accumulating into
 * it; the newer `turn.completed` usage is per-turn, so it's accumulated
 * across turns instead. Never reports its own cost: the Codex CLI never
 * reports spend, so the reading never sets totalCostUsd.
 */
function codexStreamAdapter(): EventAdapter {
  let model: string | undefined;
  // Codex's thread_id/session_id (new-format thread.started, or old-format
  // session_configured).
  let sessionId: string | undefined;

  // Codex reports a cumulative session total on every token_count event, so
  // each observation replaces the snapshot rather than accumulating into it.
  let codex: Usage | undefined;

  // Codex CLI >= 0.44's `turn.completed` usage is per-turn, not cumulative, so
  // it's accumulated across turns rather than replacing the running total.
  let codexTurns: Usage | undefined;

  return {
    observe(event: unknown): void {
      if (!isDict(event)) return;

      // Codex CLI >= 0.44 emits a flat format (top-level `type`, no envelope);
      // older CLIs emit `{id, msg: {...}}` envelopes, handled further below.
      if (event.type === "thread.started") {
        if (typeof event.thread_id === "string") sessionId ??= event.thread_id;
        return;
      }
      if (event.type === "turn.completed") {
        const usage = codexUsageFrom(event.usage);
        if (usage) codexTurns = accumulate(codexTurns ?? { inputTokens: 0, outputTokens: 0 }, usage);
        return;
      }

      // Codex CLI < 0.44 events are {id, msg: {...}} envelopes.
      const msg = event.msg;
      if (!isDict(msg)) return;
      if (msg.type === "session_configured") {
        if (typeof msg.model === "string") model ??= msg.model;
        if (typeof msg.session_id === "string") sessionId ??= msg.session_id;
        return;
      }
      if (msg.type === "token_count") {
        const info = isDict(msg.info) ? msg.info : undefined;
        const usage = codexUsageFrom(info ? info.total_token_usage : msg);
        if (usage) codex = usage;
      }
    },
    sessionId(): string | undefined {
      return sessionId;
    },
    usage(): NormalizedReading | undefined {
      // Old-format cumulative snapshot wins when both somehow exist.
      const usage = codex ?? codexTurns;
      if (!usage) return undefined;
      const sample: NormalizedSample = { ...usage };
      if (model) sample.model = model;
      const reading: NormalizedReading = { samples: [sample] };
      if (model) reading.model = model;
      return reading;
    },
  };
}

/** An adapter that observes nothing: used for a provider with no registered adapter. */
function inertAdapter(): EventAdapter {
  return {
    observe(): void {},
    sessionId(): string | undefined {
      return undefined;
    },
    usage(): NormalizedReading | undefined {
      return undefined;
    },
  };
}

/** Adding a new coding agent means adding one adapter here; nothing downstream changes. */
const ADAPTERS: Record<string, () => EventAdapter> = {
  claude: claudeStreamAdapter,
  codex: codexStreamAdapter,
};

/**
 * Collects usage across one agent execution's stream-json events and reduces
 * it to a single CostEntry. One collector per execution: create a fresh one
 * for each `runAgent` call. An unknown provider gets an inert adapter
 * (observes nothing, reports no usage) rather than a throw: usage capture
 * must never break a run.
 */
export function usageCollector(provider: string): UsageCollector {
  const adapter = (ADAPTERS[provider] ?? inertAdapter)();

  return {
    observe(event: unknown): void {
      adapter.observe(event);
    },
    sessionId(): string | undefined {
      return adapter.sessionId();
    },
    snapshot({ label, subscription, fallbackModel }): CostEntry | undefined {
      const reading = adapter.usage();
      if (!reading) return undefined;
      return buildCostEntry({ label, provider, subscription, fallbackModel, ...reading });
    },
  };
}
