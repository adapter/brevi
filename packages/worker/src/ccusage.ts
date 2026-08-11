import { stat } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { BREVI_HOME, type CostEntry, type CostModelUsage } from "@brevi/shared";
import type { Sandbox } from "@brevi/sandbox";
import { buildCostEntry } from "./costs.js";

/**
 * Live, per-model cost from `ccusage`, run inside the run's sandbox while an
 * agent execution is in flight. ccusage reads the Claude Code transcript
 * JSONL files directly (and, for Codex review passes, the Codex rollout
 * files), so it reports actual per-model spend rather than the approximate
 * figures reconstructed from the agent's own stdout stream (costs.ts).
 * Everything here is best-effort and tolerant of failures: a missing binary,
 * a malformed sample, or a dead sandbox must never break a run, only degrade
 * it back to the stream-parsed figure.
 */

const isDict = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Round to 6 decimals: enough precision for micro-costs without float noise. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** How often the sampler shells out to ccusage during a live execution. */
const SAMPLE_INTERVAL_MS = 45_000;

/**
 * Find a working `ccusage` invocation inside the sandbox, or undefined when
 * none is available. Checked in order:
 *   1. The sandbox PATH (the Firecracker rootfs bakes it in; a process-provider
 *      host with it installed globally also passes this way).
 *   2. For the process provider only, a host-side cache under BREVI_HOME:
 *      installed once so repeated runs never trigger a per-sample network
 *      fetch (an `npx`/`bunx`-style invocation would). Firecracker has no
 *      equivalent fallback: a rootfs without ccusage baked in just disables
 *      live sampling for that run.
 */
export async function resolveCcusageCommand(
  sandbox: Sandbox,
  providerName: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const probe = await sandbox.exec("ccusage", ["--version"], { timeoutMs: 15_000, signal });
    if (probe.exitCode === 0) return "ccusage";
  } catch {
    // fall through to the process-provider cache below
  }

  if (providerName !== "process") return undefined;

  const cacheDir = join(BREVI_HOME, "cache", "ccusage");
  const binPath = join(cacheDir, "node_modules", ".bin", "ccusage");
  try {
    await stat(binPath);
  } catch {
    try {
      // cancelSignal so cancelling the run (or shutting down) kills the
      // install instead of holding the run's sandbox and concurrency slot
      // until the install finishes or times out.
      await execa("npm", ["install", "--prefix", cacheDir, "ccusage", "--no-audit", "--no-fund", "--loglevel=error"], {
        timeout: 180_000,
        cancelSignal: signal,
      });
    } catch {
      return undefined;
    }
  }

  try {
    const probe = await sandbox.exec(binPath, ["--version"], { timeoutMs: 15_000, signal });
    if (probe.exitCode === 0) return binPath;
  } catch {
    // fall through
  }
  return undefined;
}

/** One ccusage session row, reduced to what the entry builder below needs. */
interface CcusageSession {
  sessionId?: string;
  rows: CostModelUsage[];
}

/**
 * Tolerant parse of a `ccusage claude session --json --breakdown` report (as
 * emitted by the sampling pipeline's filter). Field names are matched with
 * fallbacks: the Claude-source report uses "sessions"/"sessionId"/
 * "modelName"/"cost", while the unified report and other ccusage versions
 * have used "session"/"period"/"model"/"costUSD"/"totalCost", so a version
 * drift degrades to fewer fields rather than an empty read.
 */
export function parseCcusageSessions(stdout: string): CcusageSession[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!isDict(data)) return [];
  const sessions = data.session ?? data.sessions;
  if (!Array.isArray(sessions)) return [];

  const result: CcusageSession[] = [];
  for (const session of sessions) {
    if (!isDict(session)) continue;
    const idRaw = session.period ?? session.sessionId;
    const sessionId = typeof idRaw === "string" ? idRaw : undefined;

    const breakdowns = session.modelBreakdowns;
    if (!Array.isArray(breakdowns)) continue;
    const rows: CostModelUsage[] = [];
    for (const raw of breakdowns) {
      if (!isDict(raw)) continue;
      const modelRaw = raw.modelName ?? raw.model;
      if (typeof modelRaw !== "string") continue;
      const row: CostModelUsage = {
        model: modelRaw,
        inputTokens: typeof raw.inputTokens === "number" ? raw.inputTokens : 0,
        outputTokens: typeof raw.outputTokens === "number" ? raw.outputTokens : 0,
      };
      // ccusage calls it "cacheCreationTokens"; our schema calls the same figure cacheWriteTokens.
      if (typeof raw.cacheCreationTokens === "number") row.cacheWriteTokens = raw.cacheCreationTokens;
      if (typeof raw.cacheReadTokens === "number") row.cacheReadTokens = raw.cacheReadTokens;
      // ccusage reports 0, not absence, for a model missing from its pricing
      // data, and it runs --offline here so that data is whatever the installed
      // ccusage bundled: a model released after it always prices at zero. Taking
      // that zero as a real cost makes it authoritative in buildCostEntry and
      // beats the pricing-table estimate, so only a positive figure counts as
      // known. Same guard the Codex session parser below applies.
      const costRaw = raw.cost ?? raw.costUSD ?? raw.totalCost;
      if (typeof costRaw === "number" && costRaw > 0) row.costUsd = round6(costRaw);
      rows.push(row);
    }
    if (rows.length === 0) continue; // no usable model rows: not worth keeping the session
    result.push({ sessionId, rows });
  }
  return result;
}

/** One ccusage Codex session, reduced to what the entry builder below needs. */
export interface CodexCcusageSession {
  sessionId?: string;
  rows: CostModelUsage[];
  /** Absent when ccusage reports 0 (a model missing from its pricing data), not just when the field is missing. */
  costUsd?: number;
}

/**
 * Tolerant parse of a `ccusage codex session --json --offline` report. Unlike
 * the Claude report, Codex sessions carry no per-model cost, only a
 * session-level `costUSD`, so the model breakdown here is tokens-only until
 * `ccusageCostEntry` folds the session total back in.
 */
export function parseCodexCcusageSessions(stdout: string): CodexCcusageSession[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!isDict(data)) return [];
  const sessions = data.sessions;
  if (!Array.isArray(sessions)) return [];

  const result: CodexCcusageSession[] = [];
  for (const session of sessions) {
    if (!isDict(session)) continue;
    const idRaw = session.sessionId ?? session.sessionFile;
    const sessionId = typeof idRaw === "string" ? idRaw : undefined;

    const models = session.models;
    if (!isDict(models)) continue;
    const rows: CostModelUsage[] = [];
    for (const [modelName, raw] of Object.entries(models)) {
      if (!isDict(raw)) continue;
      const row: CostModelUsage = {
        model: modelName,
        inputTokens: typeof raw.inputTokens === "number" ? raw.inputTokens : 0,
        outputTokens: typeof raw.outputTokens === "number" ? raw.outputTokens : 0,
      };
      if (typeof raw.cacheReadTokens === "number") row.cacheReadTokens = raw.cacheReadTokens;
      if (typeof raw.cacheCreationTokens === "number") row.cacheWriteTokens = raw.cacheCreationTokens;
      rows.push(row);
    }
    if (rows.length === 0) continue; // no usable model rows: not worth keeping the session

    // ccusage reports 0, not absence, for a session whose model isn't in its
    // pricing data; a zero would silently beat the caller's table estimate,
    // so only a genuinely positive figure is treated as known.
    const costRaw = session.costUSD;
    const costUsd = typeof costRaw === "number" && costRaw > 0 ? round6(costRaw) : undefined;
    // A single-model session's total cost is exactly that model's cost, so
    // the dashboard's per-model breakdown can show it too.
    const onlyRow = rows.length === 1 ? rows[0] : undefined;
    if (costUsd !== undefined && onlyRow) onlyRow.costUsd = costUsd;
    result.push({ sessionId, rows, costUsd });
  }
  return result;
}

/**
 * Adapt a session's per-model ccusage rows into the shared accumulator
 * (buildCostEntry in costs.ts): the rows already are normalized per-model
 * samples, so this only supplies the provider metadata and the session-level
 * cost. Roll-up, model resolution, pricing fallback, and estimated-flag
 * semantics all live in the one shared snapshot path.
 */
export function ccusageCostEntry(options: {
  label: string;
  rows: CostModelUsage[];
  subscription: boolean;
  fallbackModel?: string;
  provider?: string;
  /** Session-level cost (Codex reports pricing per session, not per model row): the authoritative execution total when present. */
  sessionCostUsd?: number;
}): CostEntry {
  const { label, rows, subscription, fallbackModel, provider = "claude", sessionCostUsd } = options;
  return buildCostEntry({
    label,
    provider,
    subscription,
    samples: rows,
    totalCostUsd: sessionCostUsd,
    fallbackModel,
  });
}

export interface CcusageSampler {
  /** Rows from the most recent successful sample, or undefined before the first one lands. */
  latest(): CostModelUsage[] | undefined;
  /** Stop scheduling further samples. Idempotent. */
  stop(): void;
  /**
   * Stop, then take one last sample directly. Falls back to `latest()` when
   * the read fails, throws, or finds no row for the current session, so a
   * dead sandbox or a cancelled run still keeps the last interim reading.
   */
  finalRead(): Promise<CostModelUsage[] | undefined>;
}

/**
 * Reduces the ccusage report to the current execution's session row before it
 * leaves the sandbox. The report covers every session ccusage can see (on the
 * process provider that is the host's entire shared transcript history), and
 * the provider capture buffer keeps only the tail of stdout, so the full
 * report must never be what crosses that buffer: it would truncate from the
 * front and every sample would fail to parse. ccusage's own `--id` filter is
 * no help here: it switches to a per-message output shape that drops the
 * per-model cost breakdown. Kept free of single quotes so it can sit inside
 * the single-quoted `node -e` argument of the pipeline below; the session id
 * arrives as an argv, never interpolated into the script.
 */
const SESSION_FILTER_JS = [
  'let s="";',
  'process.stdin.on("data",(d)=>{s+=d});',
  'process.stdin.on("end",()=>{',
  "let data;",
  "try{data=JSON.parse(s)}catch{process.exit(3)}",
  "const rows=data&&(data.sessions??data.session);",
  "if(!Array.isArray(rows))process.exit(3);",
  "const hit=rows.filter((r)=>r&&(r.sessionId??r.period)===process.argv[1]);",
  'process.stdout.write(JSON.stringify({sessions:hit}));',
  "});",
].join("");

/**
 * The per-sample command: the resolved ccusage binary and the session id come
 * in as positional parameters, so neither is ever spliced into shell text.
 * `claude session` (rather than the unified `session` report) pins the read
 * to the Claude Code transcripts, which is the only source these samples are
 * about. node is guaranteed wherever ccusage runs: both are node CLIs.
 */
const SAMPLE_PIPELINE = `"$1" claude session --json --breakdown --offline | node -e '${SESSION_FILTER_JS}' "$2"`;

/**
 * Same shape and constraints as SESSION_FILTER_JS (no single quotes; the
 * session id arrives as an argv, never interpolated), but for a Codex report:
 * reads `data.sessions` and matches by containment rather than equality,
 * since ccusage's Codex sessionId is a dated path around the rollout uuid
 * (e.g. "2026/08/07/rollout-<ts>-<uuid>"), not the bare uuid the caller has.
 */
const CODEX_SESSION_FILTER_JS = [
  'let s="";',
  'process.stdin.on("data",(d)=>{s+=d});',
  'process.stdin.on("end",()=>{',
  "let data;",
  "try{data=JSON.parse(s)}catch{process.exit(3)}",
  "const rows=data&&data.sessions;",
  "if(!Array.isArray(rows))process.exit(3);",
  'const hit=rows.filter((r)=>r&&typeof r.sessionId==="string"&&r.sessionId.includes(process.argv[1]));',
  'process.stdout.write(JSON.stringify({sessions:hit}));',
  "});",
].join("");

/**
 * The one-shot Codex read command. `codex session` (rather than `claude
 * session`) pins the read to the Codex rollout files under CODEX_HOME. The
 * in-sandbox filter exists for the same reason as the Claude pipeline's: on
 * the process provider a default CODEX_HOME is the host's own `~/.codex`
 * with its entire session history, which would overflow the provider's
 * capture buffer if it crossed unfiltered.
 */
const CODEX_READ_PIPELINE = `"$1" codex session --json --offline | node -e '${CODEX_SESSION_FILTER_JS}' "$2"`;

/**
 * One-shot ccusage read of a single Codex review exec's rollout session, run
 * after the exec has exited. No sampler like startCcusageSampler below: a
 * review pass's rollout file is complete once its exec exits (unlike a live
 * Claude execution, which is sampled while still running), so a single
 * post-exec read is enough. Never throws; a missing binary, a malformed
 * report, or a dead sandbox all just resolve to undefined.
 */
export async function readCodexSessionUsage(options: {
  sandbox: Sandbox;
  command: string;
  codexHome: string | undefined;
  sessionId: string;
  signal: AbortSignal;
}): Promise<CodexCcusageSession | undefined> {
  const { sandbox, command, codexHome, sessionId, signal } = options;
  try {
    const result = await sandbox.exec("sh", ["-c", CODEX_READ_PIPELINE, "ccusage-codex", command, sessionId], {
      cwd: sandbox.workspacePath,
      env: codexHome ? { CODEX_HOME: codexHome } : undefined,
      timeoutMs: 30_000,
      signal,
    });
    if (result.exitCode !== 0) return undefined;
    return parseCodexCcusageSessions(result.stdout).find((s) => s.rows.length > 0);
  } catch {
    return undefined;
  }
}

/**
 * Periodically runs the ccusage sampling pipeline inside the sandbox and
 * reports the per-model rows for the execution's Claude session. Uses a
 * recursive setTimeout (not setInterval) so a slow sample can never overlap
 * the next tick, and an in-flight flag guards the same invariant against a
 * tick firing while a previous sample (or finalRead) is still out.
 */
export function startCcusageSampler(options: {
  sandbox: Sandbox;
  command: string;
  getSessionId: () => string | undefined;
  signal: AbortSignal;
  onSample: (rows: CostModelUsage[]) => void;
}): CcusageSampler {
  const { sandbox, command, getSessionId, signal, onSample } = options;

  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latestRows: CostModelUsage[] | undefined;

  async function sampleOnce(): Promise<CostModelUsage[] | undefined> {
    const sessionId = getSessionId();
    if (!sessionId) return undefined;
    try {
      const result = await sandbox.exec("sh", ["-c", SAMPLE_PIPELINE, "ccusage-sample", command, sessionId], {
        cwd: sandbox.workspacePath,
        timeoutMs: 30_000,
        signal,
      });
      if (result.exitCode !== 0) return undefined;
      const session = parseCcusageSessions(result.stdout).find((s) => s.sessionId === sessionId);
      return session?.rows;
    } catch {
      return undefined;
    }
  }

  function scheduleNext(): void {
    if (stopped) return;
    timer = setTimeout(() => void tick(), SAMPLE_INTERVAL_MS);
  }

  async function tick(): Promise<void> {
    timer = undefined;
    if (stopped || signal.aborted) return;
    if (inFlight || !getSessionId()) {
      // No session id yet (init event hasn't arrived): skip this tick and try again later.
      scheduleNext();
      return;
    }
    inFlight = true;
    const rows = await sampleOnce();
    inFlight = false;
    // A slow in-flight sample must never emit after stop(): it could overwrite
    // the final reconciled entry with stale interim data.
    if (stopped) return;
    if (rows && rows.length > 0) {
      latestRows = rows;
      onSample(rows);
    }
    scheduleNext();
  }

  function stop(): void {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  scheduleNext();

  return {
    latest(): CostModelUsage[] | undefined {
      return latestRows;
    },
    stop,
    async finalRead(): Promise<CostModelUsage[] | undefined> {
      stop();
      try {
        const rows = await sampleOnce();
        if (rows && rows.length > 0) {
          latestRows = rows;
          return rows;
        }
      } catch {
        // fall through to latest()
      }
      return latestRows;
    },
  };
}
