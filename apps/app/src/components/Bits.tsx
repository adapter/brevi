import type { PrState, RunStatus } from "@brevi/shared";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { STATUS_TONE } from "../lib/status";
import { External, Merge, Pull, Repo, Warn } from "./Icons";

/** Small shared parts. Every field on a strip is built from these. */

export function Plate({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <span className={`plate ${className}`}>{children}</span>;
}

export function StatusDot({ status, size = 7 }: { status: RunStatus; size?: number }) {
  const tone = STATUS_TONE[status];
  return (
    <span
      className={`inline-block shrink-0 rounded-full ${tone.fill} ${tone.fg} ${
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

/** GitHub's four PR states, in GitHub's own colours (see index.css). */
const PR_TONE: Record<PrState, { label: string; fg: string; wash: string; edge: string }> = {
  open: { label: "Open", fg: "text-pr-open", wash: "bg-pr-open/12", edge: "border-pr-open/40" },
  draft: { label: "Draft", fg: "text-pr-draft", wash: "bg-pr-draft/12", edge: "border-pr-draft/40" },
  merged: { label: "Merged", fg: "text-pr-merged", wash: "bg-pr-merged/12", edge: "border-pr-merged/40" },
  closed: { label: "Closed", fg: "text-pr-closed", wash: "bg-pr-closed/12", edge: "border-pr-closed/40" },
};

/**
 * The run's PR and its fate on GitHub. With `onOpen` the chip opens brevi's
 * own pull request view and a small satellite icon links out to GitHub;
 * without it the chip itself links out, as before.
 */
export function PrChip({
  url,
  state,
  onOpen,
  className,
}: {
  url: string;
  state: PrState;
  /** Opens the internal pull request page for this PR. */
  onOpen?: () => void;
  className?: string;
}) {
  const tone = PR_TONE[state];
  const face = cn(
    badgeVariants({ variant: "outline" }),
    "touch-target transition-[filter] hover:brightness-110",
    tone.wash,
    tone.edge,
    tone.fg,
  );
  const icon = state === "merged" ? <Merge className="size-3" /> : <Pull className="size-3" />;
  if (!onOpen) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        aria-label={`Pull request ${tone.label.toLowerCase()}, opens on GitHub`}
        title={`Pull request ${tone.label.toLowerCase()} on GitHub`}
        onClick={(event) => event.stopPropagation()}
        className={cn(face, className)}
      >
        {icon}
        {tone.label}
      </a>
    );
  }
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <button
        type="button"
        aria-label={`Pull request ${tone.label.toLowerCase()}, opens in Mission Control`}
        title={`Pull request ${tone.label.toLowerCase()}; open it here`}
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
        className={cn(face, "cursor-pointer")}
      >
        {icon}
        {tone.label}
      </button>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        aria-label="Open the pull request on GitHub"
        title="Open on GitHub"
        onClick={(event) => event.stopPropagation()}
        className="touch-target inline-flex items-center text-haze-600 transition-colors hover:text-haze-200"
      >
        <External className="size-3" />
      </a>
    </span>
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
    <code className="inline-flex max-w-full select-all items-start gap-2 rounded-md border border-ink-600 bg-ink-950/70 px-2 py-1.5 font-mono text-[11.5px] text-haze-200">
      <span className="text-haze-700 select-none">$</span>
      <span className="min-w-0 break-all whitespace-pre-wrap">{text}</span>
    </code>
  );
}
