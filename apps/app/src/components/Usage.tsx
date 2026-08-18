import { useCallback, useEffect, useMemo, useState } from "react";
import type { MachineUsage, UsageResponse } from "@brevi/shared";
// Runtime import via the subpath: the shared root index pulls in node-only
// modules (paths.ts reads os.homedir) that must never reach the browser.
import { mergeModelRows } from "@brevi/shared/usage";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api } from "../lib/api";
import { Plate } from "./Bits";
import { Refresh } from "./Icons";

/**
 * The Usage page: agent spend over time, per machine, read with ccusage's
 * daily report on the host and on every connected worker. One chart, one
 * axis (cost); token figures live in the tooltip and the table below.
 */

/** Fixed categorical assignment: machine i wears series (i mod 5), both themes. */
const SERIES = [
  "var(--color-series-1)",
  "var(--color-series-2)",
  "var(--color-series-3)",
  "var(--color-series-4)",
  "var(--color-series-5)",
];

const PROVIDER_LABEL: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
};

const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];

/** "YYYY-MM-DD" in local time, matching how ccusage keys its days. */
function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** The last `range` calendar days, ascending, ending today. */
function windowDays(range: Range): string[] {
  const days: string[] = [];
  const cursor = new Date();
  cursor.setDate(cursor.getDate() - (range - 1));
  for (let i = 0; i < range; i++) {
    days.push(dayKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

const usd = (value: number) =>
  value >= 100 ? `$${Math.round(value)}` : `$${value.toFixed(2)}`;
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** Short axis/tooltip label for a "YYYY-MM-DD" key, e.g. "Aug 17". */
function dayLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** A rect path whose top corners are rounded; data ends round, baseline doesn't. */
function topRoundedRect(x: number, y: number, w: number, h: number, r: number): string {
  const radius = Math.min(r, w / 2, h);
  return [
    `M ${x} ${y + h}`,
    `L ${x} ${y + radius}`,
    `Q ${x} ${y} ${x + radius} ${y}`,
    `L ${x + w - radius} ${y}`,
    `Q ${x + w} ${y} ${x + w} ${y + radius}`,
    `L ${x + w} ${y + h}`,
    "Z",
  ].join(" ");
}

export function UsagePage() {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<Range>(30);
  const [hovered, setHovered] = useState<number | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .usage()
      .then((response) => setData(response))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const machines = useMemo(() => data?.machines ?? [], [data]);
  const days = useMemo(() => windowDays(range), [range]);

  /** Per-day, per-machine cost for the window, plus each machine's range totals. */
  const view = useMemo(() => {
    const byMachine = machines.map((machine) => {
      const byDate = new Map(machine.days.map((day) => [day.date, day]));
      return { machine, byDate };
    });
    const columns = days.map((date) => {
      const segments = byMachine.map(({ byDate }) => byDate.get(date)?.costUsd ?? 0);
      return { date, segments, total: segments.reduce((a, b) => a + b, 0) };
    });
    const models = mergeModelRows(
      ...byMachine.flatMap(({ byDate }) =>
        days.map((date) => byDate.get(date)?.models ?? []),
      ),
    );
    const totals = byMachine.map(({ machine, byDate }) => {
      const inWindow = days
        .map((date) => byDate.get(date))
        .filter((day): day is NonNullable<typeof day> => day !== undefined);
      return {
        machine,
        costUsd: inWindow.reduce((a, d) => a + d.costUsd, 0),
        inputTokens: inWindow.reduce((a, d) => a + d.inputTokens, 0),
        outputTokens: inWindow.reduce((a, d) => a + d.outputTokens, 0),
        cacheReadTokens: inWindow.reduce((a, d) => a + d.cacheReadTokens, 0),
        cacheWriteTokens: inWindow.reduce((a, d) => a + d.cacheWriteTokens, 0),
      };
    });
    return { columns, totals, models };
  }, [machines, days]);

  const rangeCost = view.totals.reduce((a, t) => a + t.costUsd, 0);
  // Cache-inclusive, matching ccusage's own totalTokens: with prompt caching
  // the raw inputTokens figure is a sliver of what actually reached the model.
  const rangeTokens = view.totals.reduce(
    (a, t) => a + t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens,
    0,
  );
  const rangeOut = view.totals.reduce((a, t) => a + t.outputTokens, 0);
  const failing = machines.filter((machine) => machine.error);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-5 sm:py-7 md:px-8">
      <header className="flex items-center gap-2.5">
        <h2 className="text-[16px] font-semibold text-haze-50">Usage</h2>
        <span className="ml-auto flex items-center gap-2">
          <div className="flex items-center rounded-full border border-ink-600 p-0.5" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                aria-pressed={range === r}
                className={`touch-target cursor-pointer rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  range === r ? "bg-ink-750 text-haze-50" : "text-haze-500 hover:text-haze-200"
                }`}
              >
                {r}d
              </button>
            ))}
          </div>
          <Button variant="outline" size="plate" onClick={load} disabled={loading}>
            <Refresh className={`size-3 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </span>
      </header>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-haze-400">
        What the agents on this machine and every connected worker have spent, day by day, as
        reported by ccusage from their Claude Code and Codex transcripts. Not limited to brevi
        runs: everything ccusage can see on a machine counts. Token totals include cache reads
        and writes; the Input column counts only fresh, uncached input.
      </p>

      {loading && !data ? (
        <p className="mt-6 text-[12.5px] leading-relaxed text-haze-600">
          Reading usage on each machine. The first read can take a minute while ccusage is
          installed.
        </p>
      ) : error && !data ? (
        <div className="mt-6 rounded-lg border border-rust-500/35 bg-rust-500/8 p-3">
          <p className="text-[12.5px] leading-relaxed text-rust-400">{error}</p>
        </div>
      ) : (
        <>
          <div className="mt-5 grid grid-cols-3 gap-2.5">
            <StatTile label={`Cost, last ${range} days`} value={usd(rangeCost)} />
            <StatTile label="Tokens, total" value={compact.format(rangeTokens)} />
            <StatTile label="Output tokens" value={compact.format(rangeOut)} />
          </div>

          <Card className="mt-2.5 block px-4 py-3.5">
            <div className="flex items-center gap-2">
              <Plate className="text-haze-400">Cost per day</Plate>
              {machines.length > 1 && (
                <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
                  {machines.map((machine, i) => (
                    <span key={machine.id} className="flex items-center gap-1.5">
                      <span
                        className="inline-block size-2 rounded-full"
                        style={{ background: SERIES[i % SERIES.length] }}
                        aria-hidden="true"
                      />
                      <span className="text-[11px] text-haze-300">{machine.name}</span>
                    </span>
                  ))}
                </span>
              )}
            </div>
            <UsageChart
              columns={view.columns}
              machines={machines}
              hovered={hovered}
              onHover={setHovered}
            />
          </Card>

          {view.models.length > 0 && (
            <Card className="mt-2.5 block overflow-x-auto px-4 py-3.5">
              <Plate className="text-haze-400">By model</Plate>
              <table className="mt-2.5 w-full text-left text-[12px]">
                <thead>
                  <tr className="text-[10.5px] font-medium text-haze-600">
                    <th className="py-1 pr-3 font-medium">Model</th>
                    <th className="py-1 pr-3 font-medium">Provider</th>
                    <th className="py-1 pr-3 text-right font-medium">Cost</th>
                    <th className="py-1 pr-3 text-right font-medium">Tokens</th>
                    <th className="py-1 pr-3 text-right font-medium">Output</th>
                    <th className="w-32 py-1 pl-3 font-medium">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {view.models.map((row) => {
                    const share = rangeCost > 0 ? row.costUsd / rangeCost : 0;
                    return (
                      <tr
                        key={`${row.provider}/${row.model}`}
                        className="border-t border-ink-700/70 text-haze-200"
                      >
                        <td className="py-1.5 pr-3 font-mono text-[11.5px]">{row.model}</td>
                        <td className="py-1.5 pr-3 text-haze-400">
                          {PROVIDER_LABEL[row.provider] ?? row.provider}
                        </td>
                        <td className="py-1.5 pr-3 text-right font-mono tabular-nums">
                          {usd(row.costUsd)}
                        </td>
                        <td className="py-1.5 pr-3 text-right font-mono tabular-nums">
                          {compact.format(
                            row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens,
                          )}
                        </td>
                        <td className="py-1.5 pr-3 text-right font-mono tabular-nums">
                          {compact.format(row.outputTokens)}
                        </td>
                        <td className="py-1.5 pl-3">
                          <span className="flex items-center gap-2">
                            <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-ink-700">
                              <span
                                className="block h-full rounded-full bg-haze-400"
                                style={{ width: `${Math.max(share * 100, 2)}%` }}
                              />
                            </span>
                            <span className="font-mono text-[10.5px] tabular-nums text-haze-500">
                              {Math.round(share * 100)}%
                            </span>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          )}

          <Card className="mt-2.5 block overflow-x-auto px-4 py-3.5">
            <Plate className="text-haze-400">By machine</Plate>
            <table className="mt-2.5 w-full text-left text-[12px]">
              <thead>
                <tr className="text-[10.5px] font-medium text-haze-600">
                  <th className="py-1 pr-3 font-medium">Machine</th>
                  <th className="py-1 pr-3 text-right font-medium">Cost</th>
                  <th className="py-1 pr-3 text-right font-medium">Tokens</th>
                  <th className="py-1 pr-3 text-right font-medium">Input</th>
                  <th className="py-1 pr-3 text-right font-medium">Output</th>
                  <th className="py-1 pr-3 text-right font-medium">Cache read</th>
                  <th className="py-1 text-right font-medium">Cache write</th>
                </tr>
              </thead>
              <tbody>
                {view.totals.map(({ machine, ...t }, i) => (
                  <tr key={machine.id} className="border-t border-ink-700/70 text-haze-200">
                    <td className="py-1.5 pr-3">
                      <span className="flex items-center gap-1.5">
                        <span
                          className="inline-block size-2 shrink-0 rounded-full"
                          style={{ background: SERIES[i % SERIES.length] }}
                          aria-hidden="true"
                        />
                        {machine.name}
                      </span>
                    </td>
                    <td className="py-1.5 pr-3 text-right font-mono tabular-nums">{usd(t.costUsd)}</td>
                    <td className="py-1.5 pr-3 text-right font-mono tabular-nums">
                      {compact.format(t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens)}
                    </td>
                    <td className="py-1.5 pr-3 text-right font-mono tabular-nums">{compact.format(t.inputTokens)}</td>
                    <td className="py-1.5 pr-3 text-right font-mono tabular-nums">{compact.format(t.outputTokens)}</td>
                    <td className="py-1.5 pr-3 text-right font-mono tabular-nums">{compact.format(t.cacheReadTokens)}</td>
                    <td className="py-1.5 text-right font-mono tabular-nums">{compact.format(t.cacheWriteTokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {failing.length > 0 && (
            <div className="mt-2.5 rounded-lg border border-iris-400/35 bg-iris-400/8 p-3">
              {failing.map((machine) => (
                <p key={machine.id} className="text-[12px] leading-relaxed text-iris-400">
                  {machine.name}: {machine.error}
                </p>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <Card className="block px-4 py-3">
      <span className="plate text-haze-600">{label}</span>
      <p className="mt-1.5 font-mono text-[20px] leading-none font-medium tabular-nums text-haze-50">
        {value}
      </p>
    </Card>
  );
}

/** Chart geometry, in viewBox units. */
const W = 900;
const H = 220;
const PAD = { top: 8, right: 4, bottom: 22, left: 40 };

function UsageChart({
  columns,
  machines,
  hovered,
  onHover,
}: {
  columns: { date: string; segments: number[]; total: number }[];
  machines: MachineUsage[];
  hovered: number | null;
  onHover: (index: number | null) => void;
}) {
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const max = Math.max(...columns.map((c) => c.total), 0.01);
  // A clean axis ceiling: 1/2/5 x 10^n just above the tallest day.
  const ceil = niceCeiling(max);
  const scale = (v: number) => (v / ceil) * plotH;
  const step = plotW / columns.length;
  const barW = Math.max(2, Math.min(26, step * 0.62));
  const gridLines = [0.25, 0.5, 0.75, 1];
  // Sparse x labels: aim for ~6, snapped to whole days.
  const labelEvery = Math.max(1, Math.round(columns.length / 6));
  const hoveredColumn = hovered !== null ? columns[hovered] : undefined;

  return (
    <div className="relative mt-2" onMouseLeave={() => onHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" role="img" aria-label="Cost per day, stacked by machine">
        {gridLines.map((f) => {
          const y = PAD.top + plotH - f * plotH;
          return (
            <g key={f}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} stroke="var(--color-ink-700)" strokeWidth="1" />
              <text x={PAD.left - 6} y={y + 3} textAnchor="end" fontSize="10" fill="var(--color-haze-600)">
                {usd(ceil * f)}
              </text>
            </g>
          );
        })}
        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={PAD.top + plotH}
          y2={PAD.top + plotH}
          stroke="var(--color-ink-600)"
          strokeWidth="1"
        />
        {columns.map((column, i) => {
          const x = PAD.left + i * step + (step - barW) / 2;
          const dim = hovered !== null && hovered !== i;
          let yCursor = PAD.top + plotH;
          const parts: React.ReactNode[] = [];
          const drawn = column.segments
            .map((v, m) => ({ v, m }))
            .filter(({ v }) => v > 0);
          drawn.forEach(({ v, m }, order) => {
            const h = Math.max(scale(v), 1);
            yCursor -= h;
            const top = order === drawn.length - 1;
            parts.push(
              top ? (
                <path
                  key={m}
                  d={topRoundedRect(x, yCursor, barW, h, 3)}
                  fill={SERIES[m % SERIES.length]}
                />
              ) : (
                <rect key={m} x={x} y={yCursor} width={barW} height={h} fill={SERIES[m % SERIES.length]} />
              ),
            );
            // 2px surface gap between stacked segments.
            yCursor -= 2;
          });
          return (
            <g key={column.date} opacity={dim ? 0.45 : 1}>
              {parts}
              {i % labelEvery === 0 && (
                <text
                  x={PAD.left + i * step + step / 2}
                  y={H - 6}
                  textAnchor="middle"
                  fontSize="10"
                  fill="var(--color-haze-600)"
                >
                  {dayLabel(column.date)}
                </text>
              )}
              {/* Full-column hover target, wider than the mark. */}
              <rect
                x={PAD.left + i * step}
                y={PAD.top}
                width={step}
                height={plotH}
                fill="transparent"
                onMouseEnter={() => onHover(i)}
              />
            </g>
          );
        })}
      </svg>

      {hoveredColumn && hovered !== null && (
        <div
          className="pointer-events-none absolute top-1 z-10 min-w-36 rounded-lg border border-ink-600 bg-ink-850 px-2.5 py-2 shadow-lg shadow-black/20"
          style={
            hovered / columns.length > 0.6
              ? { right: `${(1 - (PAD.left + hovered * step) / W) * 100}%` }
              : { left: `${((PAD.left + (hovered + 1) * step) / W) * 100}%` }
          }
        >
          <p className="text-[11px] font-medium text-haze-200">{dayLabel(hoveredColumn.date)}</p>
          {machines.map((machine, m) => {
            const v = hoveredColumn.segments[m] ?? 0;
            if (v === 0) return null;
            return (
              <p key={machine.id} className="mt-1 flex items-center gap-1.5 text-[11px] text-haze-300">
                <span
                  className="inline-block size-2 shrink-0 rounded-full"
                  style={{ background: SERIES[m % SERIES.length] }}
                  aria-hidden="true"
                />
                {machine.name}
                <span className="ml-auto pl-3 font-mono tabular-nums text-haze-200">{usd(v)}</span>
              </p>
            );
          })}
          {hoveredColumn.total === 0 ? (
            <p className="mt-1 text-[11px] text-haze-600">No usage</p>
          ) : (
            <p className="mt-1 flex items-center gap-1.5 border-t border-ink-700 pt-1 text-[11px] text-haze-400">
              Total
              <span className="ml-auto pl-3 font-mono tabular-nums text-haze-100">
                {usd(hoveredColumn.total)}
              </span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** The smallest 1/2/5 x 10^n at or above `value`. */
function niceCeiling(value: number): number {
  const power = Math.floor(Math.log10(value));
  const base = 10 ** power;
  for (const m of [1, 2, 5, 10]) {
    if (m * base >= value) return m * base;
  }
  return 10 * base;
}
