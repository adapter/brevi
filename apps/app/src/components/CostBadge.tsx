import type { CostEntry, CostModelTotal, CostTotals } from "@brevi/shared";
import { summarizeCosts } from "@brevi/shared/types";
import { useState } from "react";
import { badgeVariants } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { tokens, usd } from "../lib/format";

/**
 * The total LLM cost of a run, hoverable for a per-model breakdown summed
 * across the run's attempts and phases. Click pins the breakdown open (click
 * again, click outside, or Escape unpins); pinning is local state layered on
 * top of the tooltip's own hover state so hovering elsewhere never closes a
 * pinned breakdown.
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
  const computed = entries.length > 0 ? summarizeCosts(entries) : undefined;
  const sums = totals ?? computed;
  const byModel = totals?.byModel ?? computed?.byModel ?? [];
  if (entries.length === 0 && !sums) return null;

  const label =
    sums?.costUsd !== undefined
      ? usd(sums.costUsd)
      : sums
        ? `${tokens(totalTokens(sums))} tok`
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
        <CostBreakdown byModel={byModel} totals={sums} />
      </TooltipContent>
    </Tooltip>
  );
}

const breakdownVariants = {
  tooltip: {
    container: "min-w-64 p-2",
    header: "text-background/55",
    row: "border-t border-background/15",
    footer: "border-t border-background/25 font-medium",
    note: "text-background/50",
  },
  panel: {
    container: "p-0",
    header: "text-haze-700",
    row: "border-t border-ink-700/70",
    footer: "border-t border-ink-600 font-medium",
    note: "text-haze-600",
  },
};

/**
 * Per-model cost table shared by the badge's tooltip and the run detail
 * page's cost card. "tooltip" keeps the inverted colors of the badge
 * popover; "panel" matches the page's normal ramp for placement in a Card.
 */
export function CostBreakdown({
  byModel,
  totals,
  variant = "tooltip",
}: {
  byModel: CostModelTotal[];
  totals: CostTotals | undefined;
  variant?: "tooltip" | "panel";
}) {
  const anyEstimated = byModel.some((m) => m.estimated) || totals?.estimated === true;
  const v = breakdownVariants[variant];

  return (
    <div className={v.container}>
      <table className="w-full border-collapse font-mono text-[10.5px] tabular-nums">
        <thead>
          <tr className={v.header}>
            <th className="px-1.5 py-1 text-left font-normal">Model</th>
            <th className="px-1.5 py-1 text-right font-normal">Tokens</th>
            <th className="px-1.5 py-1 text-right font-normal">Cost</th>
          </tr>
        </thead>
        <tbody>
          {byModel.map((row) => (
            <tr key={row.model} className={v.row}>
              <td className="max-w-32 px-1.5 py-1 text-left align-top">
                <div className="truncate">{shortenModel(row.model)}</div>
              </td>
              <td className="px-1.5 py-1 text-right align-top">{tokens(totalTokens(row))}</td>
              <td className="px-1.5 py-1 text-right align-top">
                {row.costUsd !== undefined ? `${row.estimated ? "~" : ""}${usd(row.costUsd)}` : "-"}
              </td>
            </tr>
          ))}
        </tbody>
        {totals && (
          <tfoot>
            <tr className={v.footer}>
              <td className="px-1.5 py-1 text-left">Total</td>
              <td className="px-1.5 py-1 text-right">{tokens(totalTokens(totals))}</td>
              <td className="px-1.5 py-1 text-right">
                {totals.costUsd !== undefined ? `${totals.estimated ? "~" : ""}${usd(totals.costUsd)}` : "-"}
              </td>
            </tr>
          </tfoot>
        )}
      </table>
      {anyEstimated && (
        <p className={`px-1.5 pt-1.5 font-mono text-[10px] ${v.note}`}>~ estimated from model pricing</p>
      )}
    </div>
  );
}

/** Strip the "claude-" prefix so model names stay narrow in the breakdown table. */
function shortenModel(model: string): string {
  return model.replace(/^claude-/, "");
}

/** Sum every token category, including cache reads/writes, into the displayed total. */
function totalTokens(t: CostModelTotal | CostTotals): number {
  return t.inputTokens + t.outputTokens + (t.cacheReadTokens ?? 0) + (t.cacheWriteTokens ?? 0);
}
