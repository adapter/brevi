import type { CostEntry } from "@brevi/shared";

/**
 * Reduces a coding agent's raw stream-json events into one CostEntry per
 * execution. Tolerant of shapes it doesn't recognize (newer CLI versions,
 * partial/malformed events): unrecognized events are ignored rather than
 * thrown on, since usage capture must never break a run.
 */

const isDict = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Token usage accumulated so far, before cost is attached. */
interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Present only once a cache-read figure has actually been observed. */
  cacheReadTokens?: number;
  /** Present only once a cache-write figure has actually been observed. */
  cacheWriteTokens?: number;
}

export interface UsageCollector {
  observe(event: unknown): void;
  /** One CostEntry for the execution so far, or undefined if nothing was observed. */
  snapshot(options: { label: string; provider: "claude" | "codex"; subscription: boolean }): CostEntry | undefined;
}

/**
 * Best-effort USD-per-million-token pricing, used only when the provider
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

/** Merge one Claude/Codex usage reading into a running total, keeping "never seen" distinct from zero. */
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
 * Parse a Codex `token_count` usage object (either `info.total_token_usage`
 * from newer CLIs or the msg's own fields on older ones; both are cumulative
 * for the session). Codex's input_tokens includes cached tokens, unlike
 * Claude, so the cached portion is subtracted back out to get a fresh-token
 * figure comparable to Claude's input_tokens. output_tokens already includes
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
 * Collects usage across one agent execution's stream-json events and reduces
 * it to a single CostEntry. One collector per execution: create a fresh one
 * for each `runAgent` call.
 */
export function usageCollector(): UsageCollector {
  let model: string | undefined;

  // Per-message fallback (Claude): accumulated from every "assistant" event,
  // including subagent messages. Only used when no "result" event arrives.
  let fallback: Usage = { inputTokens: 0, outputTokens: 0 };
  let fallbackSeen = false;

  // Terminal "result" event (Claude): authoritative when present, so it
  // overrides the fallback accumulation above rather than adding to it.
  let result: { usage: Usage | undefined; costUsd: number | undefined } | undefined;

  // Codex reports a cumulative session total on every token_count event, so
  // each observation replaces the snapshot rather than accumulating into it.
  let codex: Usage | undefined;

  function observe(event: unknown): void {
    if (!isDict(event)) return;

    if (event.type === "system" && event.subtype === "init") {
      if (typeof event.model === "string") model ??= event.model;
      return;
    }
    if (event.type === "assistant") {
      const message = event.message;
      if (isDict(message)) {
        if (typeof message.model === "string") model ??= message.model;
        const usage = claudeUsageFrom(message.usage);
        if (usage) {
          fallback = accumulate(fallback, usage);
          fallbackSeen = true;
        }
      }
      return;
    }
    if (event.type === "result") {
      result = {
        usage: claudeUsageFrom(event.usage),
        costUsd: typeof event.total_cost_usd === "number" ? event.total_cost_usd : undefined,
      };
      return;
    }

    // Codex CLI events are {id, msg: {...}} envelopes.
    const msg = event.msg;
    if (!isDict(msg)) return;
    if (msg.type === "session_configured") {
      if (typeof msg.model === "string") model ??= msg.model;
      return;
    }
    if (msg.type === "token_count") {
      const info = isDict(msg.info) ? msg.info : undefined;
      const usage = codexUsageFrom(info ? info.total_token_usage : msg);
      if (usage) codex = usage;
    }
  }

  function claudeSnapshot(label: string, subscription: boolean): CostEntry | undefined {
    if (!result && !fallbackSeen) return undefined;
    // The result event's usage is the authoritative roll-up (subagent usage
    // included); when present the per-message fallback is ignored entirely
    // rather than blended with it. A result without a recognized usage object
    // keeps the accumulated fallback instead of zeroing the token counts.
    const usage = result?.usage ?? fallback;
    const entry: CostEntry = {
      label,
      provider: "claude",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    };
    if (model) entry.model = model;
    if (usage.cacheReadTokens !== undefined) entry.cacheReadTokens = usage.cacheReadTokens;
    if (usage.cacheWriteTokens !== undefined) entry.cacheWriteTokens = usage.cacheWriteTokens;

    if (result && result.costUsd !== undefined) {
      entry.costUsd = result.costUsd;
      // Nothing is actually billed per token on a subscription login; the
      // provider's figure is still a modeled cost, not a real charge.
      if (subscription) entry.estimated = true;
    } else {
      // No result event arrived (crash, usage limit) or it carried no cost:
      // fall back to the pricing table.
      const costUsd = estimateCost(usage, model);
      if (costUsd !== undefined) entry.costUsd = costUsd;
      entry.estimated = true;
    }
    return entry;
  }

  function codexSnapshot(label: string): CostEntry | undefined {
    if (!codex) return undefined;
    const entry: CostEntry = {
      label,
      provider: "codex",
      inputTokens: codex.inputTokens,
      outputTokens: codex.outputTokens,
      // Codex never reports its own spend; every entry is table-estimated.
      estimated: true,
    };
    if (model) entry.model = model;
    if (codex.cacheReadTokens !== undefined) entry.cacheReadTokens = codex.cacheReadTokens;
    const costUsd = estimateCost(codex, model);
    if (costUsd !== undefined) entry.costUsd = costUsd;
    return entry;
  }

  return {
    observe,
    snapshot({ label, provider, subscription }): CostEntry | undefined {
      return provider === "codex" ? codexSnapshot(label) : claudeSnapshot(label, subscription);
    },
  };
}
