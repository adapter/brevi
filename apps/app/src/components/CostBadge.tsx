import type { CostEntry, CostTotals } from "@brevi/shared";
import { Fragment, useState } from "react";
import { badgeVariants } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { tokens, usd } from "../lib/format";

/**
 * The total LLM cost of a run, hoverable for a per-entry breakdown. Click
 * pins the breakdown open (click again, click outside, or Escape unpins);
 * pinning is local state layered on top of the tooltip's own hover state so
 * hovering elsewhere never closes a pinned breakdown.
 */
export function CostBadge({
  costs,
  totals,
  align = "end",
  className = "",
}: {
  costs: CostEntry[] | undefined;
  totals: CostTotals | undefined;
  align?: "start" | "center" | "end";
  className?: string;
}) {
  const [pinned, setPinned] = useState(false);
  const [hoverOpen, setHoverOpen] = useState(false);

  const entries = costs ?? [];
  const sums = totals ?? (entries.length > 0 ? sumEntries(entries) : undefined);
  if (entries.length === 0 && !sums) return null;

  const label =
    sums?.costUsd !== undefined
      ? usd(sums.costUsd)
      : sums
        ? `${tokens(sums.inputTokens + sums.outputTokens)} tok`
        : undefined;
  if (label === undefined) return null;

  const open = pinned || hoverOpen;

  return (
    <Tooltip
      open={open}
      onOpenChange={(next, details) => {
        switch (details.reason) {
          case "trigger-hover":
          case "trigger-focus":
            setHoverOpen(next);
            break;
          case "trigger-press":
            // Handled by the trigger's own click handler below, which toggles the pin.
            break;
          default:
            if (!next) {
              setPinned(false);
              setHoverOpen(false);
            }
        }
      }}
    >
      <TooltipTrigger
        type="button"
        closeOnClick={false}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setPinned((p) => !p);
        }}
        className={cn(
          badgeVariants({ variant: "secondary" }),
          "font-mono text-[10px] tracking-normal normal-case tabular-nums",
          className,
        )}
      >
        {label}
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        align={align}
        className="w-fit max-w-none rounded-md border border-ink-700 bg-foreground px-0 py-0 text-background"
      >
        <CostBreakdown entries={entries} totals={sums} />
      </TooltipContent>
    </Tooltip>
  );
}

function CostBreakdown({ entries, totals }: { entries: CostEntry[]; totals: CostTotals | undefined }) {
  const anyEstimated = entries.some((e) => e.estimated) || totals?.estimated === true;

  return (
    <div className="min-w-64 p-2">
      <table className="w-full border-collapse font-mono text-[10.5px] tabular-nums">
        <thead>
          <tr className="text-background/55">
            <th className="px-1.5 py-1 text-left font-normal">Entry</th>
            <th className="px-1.5 py-1 text-right font-normal">Cost</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, i) => (
            <Fragment key={i}>
              <tr className="border-t border-background/15">
                <td className="max-w-32 px-1.5 py-1 text-left align-top">
                  <div className="truncate">{entry.label}</div>
                  <div className="truncate text-background/50">
                    {entry.provider}
                    {entry.breakdown && entry.breakdown.length > 1
                      ? ` · ${entry.breakdown.length} models`
                      : entry.model
                        ? ` · ${shortenModel(entry.model)}`
                        : ""}
                  </div>
                </td>
                <td className="px-1.5 py-1 text-right align-top">
                  {entry.costUsd !== undefined ? `${entry.estimated ? "~" : ""}${usd(entry.costUsd)}` : "-"}
                </td>
              </tr>
              {entry.breakdown?.map((model) => (
                <tr key={`${i}-${model.model}`} className="border-t border-background/8 text-background/70">
                  <td className="max-w-32 py-0.5 pr-1.5 pl-4 text-left align-top">
                    <div className="truncate text-background/60">{shortenModel(model.model)}</div>
                  </td>
                  <td className="px-1.5 py-0.5 text-right align-top">
                    {model.costUsd !== undefined ? `${entry.estimated ? "~" : ""}${usd(model.costUsd)}` : "-"}
                  </td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
        {totals && (
          <tfoot>
            <tr className="border-t border-background/25 font-medium">
              <td className="px-1.5 py-1 text-left">Total</td>
              <td className="px-1.5 py-1 text-right">
                {totals.costUsd !== undefined ? `${totals.estimated ? "~" : ""}${usd(totals.costUsd)}` : "-"}
              </td>
            </tr>
          </tfoot>
        )}
      </table>
      {anyEstimated && (
        <p className="px-1.5 pt-1.5 font-mono text-[10px] text-background/50">
          ~ estimated from model pricing
        </p>
      )}
    </div>
  );
}

/**
 * Fallback totals when the run doesn't carry server-computed ones. Local
 * rather than shared's summarizeCosts: a runtime import of @brevi/shared
 * would pull its Node-only config module into the browser bundle, so the
 * dashboard only ever imports shared types.
 */
function sumEntries(entries: CostEntry[]): CostTotals {
  const totals: CostTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimated: false,
  };
  for (const entry of entries) {
    totals.inputTokens += entry.inputTokens;
    totals.outputTokens += entry.outputTokens;
    totals.cacheReadTokens += entry.cacheReadTokens ?? 0;
    totals.cacheWriteTokens += entry.cacheWriteTokens ?? 0;
    if (entry.costUsd !== undefined) totals.costUsd = (totals.costUsd ?? 0) + entry.costUsd;
    if (entry.estimated) totals.estimated = true;
  }
  return totals;
}

/** Strip the "claude-" prefix so model names stay narrow in the breakdown table. */
function shortenModel(model: string): string {
  return model.replace(/^claude-/, "");
}
