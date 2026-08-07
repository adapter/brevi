import type { RunStatus } from "@brevi/shared";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { STATUS_TONE } from "../lib/status";
import { Repo, Warn } from "./Icons";

/** Small shared parts. Every field on a strip is built from these. */

export function Plate({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <span className={`plate ${className}`}>{children}</span>;
}

export function StatusDot({ status, size = 7 }: { status: RunStatus; size?: number }) {
  const tone = STATUS_TONE[status];
  return (
    <span
      className={`inline-block shrink-0 rounded-[1.5px] ${tone.fill} ${tone.fg} ${
        status === "running" ? "animate-beacon" : ""
      }`}
      style={{ width: size, height: size }}
    />
  );
}

export function StatusChip({ status, className = "" }: { status: RunStatus; className?: string }) {
  const tone = STATUS_TONE[status];
  return (
    <Badge variant="outline" className={cn(tone.wash, tone.edge, tone.fg, className)}>
      <StatusDot status={status} size={6} />
      {tone.label}
    </Badge>
  );
}

export function RepoChip({ repo }: { repo?: string }) {
  if (!repo) {
    return (
      <Badge variant="destructive">
        <Warn className="size-3" />
        No repo mapped
      </Badge>
    );
  }
  return (
    <Badge variant="secondary">
      <Repo className="size-3 text-haze-600" />
      <span className="font-mono text-[11px] leading-none tracking-normal normal-case">{repo}</span>
    </Badge>
  );
}

export function Section({
  label,
  count,
  right,
  children,
}: {
  label: string;
  count?: number;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="animate-rise">
      <header className="mb-2.5 flex items-center gap-2">
        <Plate className="text-haze-600">{label}</Plate>
        {count !== undefined && (
          <span className="font-mono text-[11px] leading-none text-haze-700">{count}</span>
        )}
        <Separator className="flex-1" />
        {right}
      </header>
      {children}
    </section>
  );
}

/** A shell command the operator is meant to run, ready to copy. */
export function Command({ text }: { text: string }) {
  return (
    <code className="inline-flex max-w-full select-all items-start gap-2 rounded-[4px] border border-ink-600 bg-ink-950/70 px-2 py-1.5 font-mono text-[11.5px] text-haze-200">
      <span className="text-haze-700 select-none">$</span>
      <span className="min-w-0 break-all whitespace-pre-wrap">{text}</span>
    </code>
  );
}
