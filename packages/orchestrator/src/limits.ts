import type { BreviConfig, LimitInfo, LimitProvider } from "@brevi/shared";
import { validateAnthropicCredential } from "./credentials.js";

/**
 * Usage-limit handling: recognize "you've hit your limit" output from the
 * coding agents (Claude Code and Codex), work out when the limit lifts, and
 * probe the provider with a 1-token request before restarting.
 */

/** Which agent a configured command runs, for limit attribution and probing. */
export function agentProvider(config: BreviConfig): LimitProvider {
  const command = (config.agent.command.split("/").pop() ?? config.agent.command).toLowerCase();
  if (command.includes("codex")) return "codex";
  if (command.includes("grok")) return "grok";
  return "claude";
}

/** Thrown by the runner when an attempt died because of a usage limit. */
export class AgentLimitError extends Error {
  constructor(readonly limit: LimitInfo) {
    super(
      `agent usage limit reached (${limit.kind}${limit.resetsAt ? `, resets ${limit.resetsAt}` : ""})`,
    );
    this.name = "AgentLimitError";
  }
}

/**
 * True for stream-json events that carry a terminal error (error results from
 * Claude Code, error msgs from Codex). Limit detection only looks inside
 * these; scanning successful results or the rest of the transcript would
 * false-positive whenever the ticket itself talks about usage limits.
 */
export function isAgentFailureEvent(event: unknown): boolean {
  if (typeof event !== "object" || event === null) return false;
  const e = event as { type?: unknown; subtype?: unknown; is_error?: unknown; msg?: { type?: unknown } };
  if (e.type === "error" || e.is_error === true) return true;
  // A successful Claude result carries the agent's final response; only
  // error-subtyped results may feed detection.
  if (e.type === "result") return typeof e.subtype === "string" && /error/i.test(e.subtype);
  return typeof e.msg?.type === "string" && /error/i.test(e.msg.type);
}

const LIMIT_PATTERNS: RegExp[] = [
  // Claude Code subscription limits, e.g. "Claude AI usage limit reached|1735689600",
  // "5-hour limit reached ∙ resets 3pm", "Weekly limit reached ...".
  /usage limit reached/i,
  /(?:5-hour|five-hour|session|weekly) limit reached/i,
  /limit will reset/i,
  // Anthropic API 429s forwarded through the agent's stream output.
  /rate_limit_error/i,
  // Codex, e.g. "You've hit your (weekly) usage limit. Try again in 4 hours 30 minutes."
  /hit your (?:\w+ )?usage limit/i,
  /usage_limit_reached/i,
  /usage_not_included/i,
  /rate limit reached/i,
];

/** Truncation cap for the stored trigger line: enough to debug, never a transcript. */
const MAX_MESSAGE_CHARS = 300;

/**
 * Scan one line of agent output (raw stream-json or stderr) for a usage-limit
 * message. Returns the limit with its reset time when the line reports one.
 */
export function detectLimit(line: string, provider: LimitProvider, now: Date = new Date()): LimitInfo | undefined {
  if (!LIMIT_PATTERNS.some((pattern) => pattern.test(line))) return undefined;
  const kind = /week/i.test(line)
    ? "weekly"
    : /5-hour|five-hour|session limit/i.test(line)
      ? "five-hour"
      : "unknown";
  const resetsAt = parseResetTime(line, now);
  return {
    provider,
    kind,
    resetsAt: resetsAt?.toISOString(),
    message: line.length > MAX_MESSAGE_CHARS ? `${line.slice(0, MAX_MESSAGE_CHARS)}…` : line,
  };
}

/**
 * Extract a reset time from a limit message, trying the formats the agents
 * actually emit: an epoch timestamp, a "resets in" duration, or a clock time.
 */
function parseResetTime(line: string, now: Date): Date | undefined {
  // "Claude AI usage limit reached|1735689600": epoch seconds (or ms) after a pipe,
  // or an explicit epoch anywhere near "reset".
  const epoch = /(?:\|\s*|resets?(?:\s+at)?\s+)(\d{10,13})(?!\d)/i.exec(line);
  if (epoch?.[1]) {
    const value = Number(epoch[1]);
    const date = new Date(value < 1e12 ? value * 1000 : value);
    if (date.getTime() > now.getTime()) return date;
  }

  // "resets_in_seconds":12345 (Codex stream errors) or "try again in 1.5s".
  const seconds = /resets?_?in_?seconds\D{0,3}(\d+)|try again in (\d+(?:\.\d+)?)\s*s(?:ec|$|\b)/i.exec(line);
  if (seconds) {
    const value = Number(seconds[1] ?? seconds[2]);
    if (Number.isFinite(value) && value > 0) return new Date(now.getTime() + value * 1000);
  }

  // "try again in 4 hours 30 minutes" / "in 2 days" / "resets in 45 minutes".
  const duration =
    /(?:try again|resets?|available)\s+in\s+(?:(\d+)\s*d(?:ays?)?)?\s*(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?/i.exec(line);
  if (duration && (duration[1] || duration[2] || duration[3])) {
    const minutes =
      Number(duration[1] ?? 0) * 24 * 60 + Number(duration[2] ?? 0) * 60 + Number(duration[3] ?? 0);
    if (minutes > 0) return new Date(now.getTime() + minutes * 60_000);
  }

  // ISO timestamp anywhere in the line.
  const iso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/.exec(line);
  if (iso) {
    const date = new Date(iso[0]);
    if (!Number.isNaN(date.getTime()) && date.getTime() > now.getTime()) return date;
  }

  // "resets 3pm" / "try again at 11:30 AM": next occurrence of that local time.
  const clock = /(?:resets?|try again)(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\b|$)/i.exec(line);
  if (clock?.[3] || clock?.[2]) {
    let hours = Number(clock[1]);
    const minutes = Number(clock[2] ?? 0);
    const meridiem = clock[3]?.toLowerCase();
    if (meridiem === "pm" && hours < 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
    if (hours <= 23 && minutes <= 59) {
      const date = new Date(now);
      date.setHours(hours, minutes, 0, 0);
      if (date.getTime() <= now.getTime()) date.setDate(date.getDate() + 1);
      return date;
    }
  }

  return undefined;
}

/** Clock-skew cushion added after a reported reset time before retrying. */
const RESET_BUFFER_MS = 2 * 60_000;

/**
 * When the next attempt may start: shortly after the reported reset, or one
 * probe interval from now when the agent didn't say (or the reset has passed).
 */
export function resumeTimeFor(limit: LimitInfo, config: BreviConfig, now: Date = new Date()): Date {
  const fallback = new Date(now.getTime() + config.restart.probeIntervalMinutes * 60_000);
  if (!limit.resetsAt) return fallback;
  const resets = new Date(limit.resetsAt);
  if (Number.isNaN(resets.getTime()) || resets.getTime() <= now.getTime()) return fallback;
  return new Date(resets.getTime() + RESET_BUFFER_MS);
}

export interface ProbeResult {
  /** True when the limit appears to have lifted (or cannot be probed). */
  ready: boolean;
  detail: string;
}

/** Failure details from a probe that mean "still limited" rather than "broken". */
const STILL_LIMITED = /rate.?limit|usage.?limit|limit (?:reached|exceeded)|exceeded.*limit|429|quota|overloaded/i;

/**
 * Check whether the provider will accept work again with a 1-token generation
 * on its cheapest model, using the same credentials the sandboxed agent runs
 * with (so a subscription limit is tested against the same pool). Errors that
 * don't look like limits report ready; the attempt itself will surface them.
 */
export async function probeAgentLimit(config: BreviConfig, provider: LimitProvider): Promise<ProbeResult> {
  if (provider === "claude") {
    const { claudeCodeOauthToken, anthropicApiKey } = config.agent;
    const credential = claudeCodeOauthToken || anthropicApiKey;
    if (!credential) return { ready: true, detail: "no Claude credential to probe" };
    const result = await validateAnthropicCredential(
      credential,
      claudeCodeOauthToken ? "oauth" : "api-key",
    );
    if (result.ok) return { ready: true, detail: result.detail };
    if (STILL_LIMITED.test(result.detail)) return { ready: false, detail: result.detail };
    return { ready: true, detail: `probe inconclusive: ${result.detail}` };
  }

  if (provider === "grok") {
    const { xaiApiKey } = config.agent;
    if (!xaiApiKey) return { ready: true, detail: "no probe available for a Grok CLI login" };
    return probeXaiGeneration(xaiApiKey);
  }

  const { codexApiKey } = config.agent;
  if (!codexApiKey) {
    // A ChatGPT login can't be probed cheaply; trust the schedule instead.
    return { ready: true, detail: "no probe available for a ChatGPT login" };
  }
  return probeOpenAiGeneration(codexApiKey);
}

/** Cheapest model for the OpenAI generation probe. */
const OPENAI_PROBE_MODEL = "gpt-5-nano";

/**
 * A 1-token generation against OpenAI that keeps the HTTP status visible.
 * validateCodexApiKey() is not usable here: its auth-only /v1/models fallback
 * reports ok while generation is still 429-limited.
 */
async function probeOpenAiGeneration(apiKey: string): Promise<ProbeResult> {
  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: OPENAI_PROBE_MODEL,
        messages: [{ role: "user", content: "ping" }],
        max_completion_tokens: 1,
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ready: true, detail: `probe inconclusive: ${message}` };
  }
  if (res.ok) return { ready: true, detail: `verified with ${OPENAI_PROBE_MODEL}` };
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  const detail = body?.error?.message ?? `OpenAI returned ${res.status}`;
  if (res.status === 429 || STILL_LIMITED.test(detail)) return { ready: false, detail };
  return { ready: true, detail: `probe inconclusive: ${detail}` };
}

/** Cheapest model for the xAI generation probe. */
const XAI_PROBE_MODEL = "grok-4-1-fast-non-reasoning";

/**
 * A 1-token generation against xAI that keeps the HTTP status visible.
 * validateXaiApiKey() is not usable here: its auth-only /v1/models fallback
 * reports ok while generation is still 429-limited.
 */
async function probeXaiGeneration(apiKey: string): Promise<ProbeResult> {
  let res: Response;
  try {
    res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: XAI_PROBE_MODEL,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ready: true, detail: `probe inconclusive: ${message}` };
  }
  if (res.ok) return { ready: true, detail: `verified with ${XAI_PROBE_MODEL}` };
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  const detail = body?.error?.message ?? `xAI returned ${res.status}`;
  if (res.status === 429 || STILL_LIMITED.test(detail)) return { ready: false, detail };
  return { ready: true, detail: `probe inconclusive: ${detail}` };
}
