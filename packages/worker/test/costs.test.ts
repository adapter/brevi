import { describe, expect, it } from "bun:test";
import { summarizeCosts } from "@brevi/shared";
import { ccusageCostEntry, parseCcusageSessions } from "../src/ccusage.js";
import { usageCollector } from "../src/costs.js";

// Run with `bun test packages/worker` from the repo root (after
// `bun run build`, so the @brevi/shared import resolves to its dist output).
// Not part of the tsc build: the package's tsconfig only includes src/.

describe("usageCollector (codex)", () => {
  it("prices a flat-format stream via the configured fallback model", () => {
    // The Codex CLI's flat format (thread.started / turn.completed) never
    // names a model, so the entry must fall back to the configured one.
    const usage = usageCollector("codex");
    usage.observe({ type: "thread.started", thread_id: "t-1" });
    usage.observe({
      type: "turn.completed",
      usage: { input_tokens: 1_000, cached_input_tokens: 400, output_tokens: 200 },
    });

    const entry = usage.snapshot({ label: "implementation", subscription: false, fallbackModel: "gpt-5-codex" });
    if (!entry) throw new Error("expected an entry");
    expect(entry.provider).toBe("codex");
    expect(entry.model).toBe("gpt-5-codex");
    // Codex's input_tokens includes cached tokens; the cached share moves to cacheReadTokens.
    expect(entry.inputTokens).toBe(600);
    expect(entry.outputTokens).toBe(200);
    expect(entry.cacheReadTokens).toBe(400);
    // gpt-5 list pricing: 600 * 1.25 + 200 * 10 + 400 * 0.125 per million.
    expect(entry.costUsd).toBe(0.0028);
    expect(entry.estimated).toBe(true);

    const totals = summarizeCosts([entry]);
    expect(totals.byModel).toHaveLength(1);
    expect(totals.byModel?.[0]?.model).toBe("gpt-5-codex");
    expect(totals.byModel?.[0]?.costUsd).toBe(0.0028);
    expect(totals.costUsd).toBe(0.0028);
  });

  it("keeps the session id from thread.started", () => {
    const usage = usageCollector("codex");
    usage.observe({ type: "thread.started", thread_id: "t-2" });
    expect(usage.sessionId()).toBe("t-2");
  });
});

describe("usageCollector (claude)", () => {
  const init = { type: "system", subtype: "init", model: "claude-opus-5", session_id: "s-1" };
  const assistant = (model: string, usage: Record<string, number>) => ({
    type: "assistant",
    message: { model, usage },
  });

  it("keeps one breakdown row per model on the stream fallback path", () => {
    // No terminal "result" event (crash, usage limit): the per-message
    // accumulation is all there is, and a delegated execution must keep the
    // orchestrator and implementer models distinct instead of attributing
    // everything to the first model observed.
    const usage = usageCollector("claude");
    usage.observe(init);
    usage.observe(assistant("claude-opus-5", { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1_000 }));
    usage.observe(assistant("claude-haiku-4-5", { input_tokens: 400, output_tokens: 200 }));
    usage.observe(assistant("claude-opus-5", { input_tokens: 100, output_tokens: 50 }));

    const entry = usage.snapshot({ label: "implementation", subscription: false });
    if (!entry) throw new Error("expected an entry");
    expect(entry.model).toBe("claude-opus-5");
    expect(entry.inputTokens).toBe(600);
    expect(entry.outputTokens).toBe(300);
    expect(entry.cacheReadTokens).toBe(1_000);
    expect(entry.breakdown?.map((row) => row.model).sort()).toEqual(["claude-haiku-4-5", "claude-opus-5"]);
    // Each model's share prices at its own rate: opus (200 in, 100 out, 1000
    // cache-read) at 0.004 plus haiku (400 in, 200 out) at 0.0014.
    expect(entry.costUsd).toBe(0.0054);
    expect(entry.estimated).toBe(true);

    const byModel = summarizeCosts([entry]).byModel ?? [];
    expect(byModel.map((row) => row.model).sort()).toEqual(["claude-haiku-4-5", "claude-opus-5"]);
    const haiku = byModel.find((row) => row.model === "claude-haiku-4-5");
    expect(haiku?.inputTokens).toBe(400);
    expect(haiku?.outputTokens).toBe(200);
  });

  it("keeps the terminal result authoritative without dropping the per-model split", () => {
    const usage = usageCollector("claude");
    usage.observe(init);
    usage.observe(assistant("claude-opus-5", { input_tokens: 100, output_tokens: 50 }));
    usage.observe(assistant("claude-haiku-4-5", { input_tokens: 400, output_tokens: 200 }));
    usage.observe({
      type: "result",
      usage: { input_tokens: 510, output_tokens: 255 },
      total_cost_usd: 1.25,
    });

    const entry = usage.snapshot({ label: "implementation", subscription: false });
    if (!entry) throw new Error("expected an entry");
    // Top-level figures come from the result event, counted once.
    expect(entry.inputTokens).toBe(510);
    expect(entry.outputTokens).toBe(255);
    expect(entry.costUsd).toBe(1.25);
    expect(entry.estimated).toBeUndefined();
    // The per-model split survives alongside it.
    expect(entry.breakdown?.map((row) => row.model).sort()).toEqual(["claude-haiku-4-5", "claude-opus-5"]);

    const totals = summarizeCosts([entry]);
    expect(totals.costUsd).toBe(1.25);
    // The provider-reported cost lands exactly once, on the entry's own model.
    const withCost = (totals.byModel ?? []).filter((row) => row.costUsd !== undefined);
    expect(withCost.map((row) => row.model)).toEqual(["claude-opus-5"]);
    expect(withCost[0]?.costUsd).toBe(1.25);
  });

  it("stays single-model (no breakdown) for undelegated executions", () => {
    const usage = usageCollector("claude");
    usage.observe(init);
    usage.observe(assistant("claude-opus-5", { input_tokens: 100, output_tokens: 50 }));
    usage.observe({ type: "result", usage: { input_tokens: 100, output_tokens: 50 }, total_cost_usd: 0.5 });

    const entry = usage.snapshot({ label: "implementation", subscription: true });
    if (!entry) throw new Error("expected an entry");
    expect(entry.model).toBe("claude-opus-5");
    expect(entry.breakdown).toBeUndefined();
    expect(entry.costUsd).toBe(0.5);
    // A subscription login's provider-reported figure is modeled, not billed.
    expect(entry.estimated).toBe(true);
  });
});

describe("ccusageCostEntry", () => {
  it("feeds the same accumulator as the stream adapters", () => {
    const entry = ccusageCostEntry({
      label: "implementation",
      subscription: false,
      rows: [
        { model: "claude-opus-5", inputTokens: 200, outputTokens: 100, cacheReadTokens: 5_000, costUsd: 2 },
        { model: "claude-haiku-4-5", inputTokens: 300, outputTokens: 150, costUsd: 0.25 },
      ],
    });
    expect(entry.provider).toBe("claude");
    expect(entry.model).toBe("claude-opus-5");
    expect(entry.inputTokens).toBe(500);
    expect(entry.cacheReadTokens).toBe(5_000);
    expect(entry.costUsd).toBe(2.25);
    expect(entry.estimated).toBeUndefined();
    expect(entry.breakdown).toHaveLength(2);
  });

  it("prices a model ccusage could not, without disturbing the ones it could", () => {
    // ccusage runs --offline, so a model newer than its bundled pricing data
    // comes back with no usable cost while its peers price normally. The
    // unpriced row has to be filled from the table or the execution reports
    // only part of what it spent.
    const entry = ccusageCostEntry({
      label: "implementation",
      subscription: false,
      rows: [
        { model: "claude-sonnet-5", inputTokens: 332, outputTokens: 112_908, costUsd: 4.161716 },
        { model: "claude-opus-5", inputTokens: 265, outputTokens: 103_217, cacheReadTokens: 21_677_885 },
      ],
    });
    const opus = entry.breakdown?.find((row) => row.model === "claude-opus-5");
    expect(opus?.costUsd).toBeGreaterThan(0);
    // Reported figures survive untouched; only the gap is estimated.
    expect(entry.breakdown?.find((row) => row.model === "claude-sonnet-5")?.costUsd).toBe(4.161716);
    expect(entry.costUsd).toBeCloseTo(4.161716 + (opus?.costUsd ?? 0), 6);
    // Part reported, part modeled: the total is an estimate either way.
    expect(entry.estimated).toBe(true);
    // The roll-up the dashboard reads carries the filled figure too.
    const totals = summarizeCosts([entry]);
    expect(totals.byModel?.find((row) => row.model === "claude-opus-5")?.costUsd).toBe(opus?.costUsd);
  });

  it("treats a ccusage cost of zero as unknown rather than free", () => {
    const [session] = parseCcusageSessions(
      JSON.stringify({
        sessions: [
          {
            sessionId: "s1",
            modelBreakdowns: [
              { modelName: "claude-sonnet-5", inputTokens: 10, outputTokens: 20, cost: 1.5 },
              // What ccusage reports for a model absent from its pricing data.
              { modelName: "claude-opus-5", inputTokens: 30, outputTokens: 40, cost: 0 },
            ],
          },
        ],
      }),
    );
    const rows = session?.rows ?? [];
    expect(rows.find((row) => row.model === "claude-sonnet-5")?.costUsd).toBe(1.5);
    expect(rows.find((row) => row.model === "claude-opus-5")?.costUsd).toBeUndefined();
  });

  it("treats the Codex session-level cost as the execution total", () => {
    const entry = ccusageCostEntry({
      label: "review (bugs)",
      subscription: false,
      provider: "codex",
      fallbackModel: "gpt-5-codex",
      rows: [
        { model: "gpt-5-codex", inputTokens: 3_000, outputTokens: 1_200 },
        { model: "gpt-5-codex-mini", inputTokens: 200, outputTokens: 80 },
      ],
      sessionCostUsd: 0.09,
    });
    expect(entry.costUsd).toBe(0.09);
    expect(entry.model).toBe("gpt-5-codex");
    const totals = summarizeCosts([entry]);
    // Session-level cost lands exactly once in the per-model roll-up.
    expect(totals.costUsd).toBe(0.09);
    const withCost = (totals.byModel ?? []).filter((row) => row.costUsd !== undefined);
    expect(withCost).toHaveLength(1);
    expect(withCost[0]?.model).toBe("gpt-5-codex");
  });
});
