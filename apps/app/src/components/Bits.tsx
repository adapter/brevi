import type { RunStatus, Ticket } from "@brevi/shared";
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
    <span
      className={`inline-flex items-center gap-1.5 rounded-[4px] border px-1.5 py-1 ${tone.wash} ${tone.edge} ${tone.fg} ${className}`}
    >
      <StatusDot status={status} size={6} />
      <span className="plate">{tone.label}</span>
    </span>
  );
}

export function KindChip({ kind }: { kind: Ticket["kind"] }) {
  if (kind === "spike") {
    return (
      <span className="plate inline-flex items-center rounded-[4px] border border-iris-400/35 bg-iris-400/12 px-1.5 py-1 text-iris-400">
        Spike
      </span>
    );
  }
  return (
    <span className="plate inline-flex items-center rounded-[4px] border border-ink-600 px-1.5 py-1 text-haze-600">
      Impl
    </span>
  );
}

export function RepoChip({ repo }: { repo?: string }) {
  if (!repo) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-[4px] border border-rust-500/35 bg-rust-500/10 px-1.5 py-1 text-rust-400">
        <Warn className="size-3" />
        <span className="plate">No repo mapped</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-[4px] border border-ink-600 bg-ink-800 px-1.5 py-1 text-haze-300">
      <Repo className="size-3 text-haze-600" />
      <span className="font-mono text-[11px] leading-none">{repo}</span>
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
        <span className="h-px flex-1 bg-ink-700" />
        {right}
      </header>
      {children}
    </section>
  );
}

export function Button({
  children,
  onClick,
  tone = "ghost",
  disabled,
  title,
  type = "button",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  tone?: "ghost" | "ember" | "rust";
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
}) {
  const tones = {
    ghost:
      "border-ink-600 text-haze-300 hover:border-ink-500 hover:bg-ink-750 hover:text-haze-50",
    ember:
      "border-ember-600/50 bg-ember-500/10 text-ember-500 hover:border-ember-500 hover:bg-ember-500 hover:text-ink-950",
    rust: "border-rust-600/50 bg-rust-500/10 text-rust-400 hover:border-rust-500 hover:bg-rust-500 hover:text-ink-950",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`plate inline-flex items-center gap-1.5 rounded-[4px] border px-2 py-1.5 transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${tones[tone]}`}
    >
      {children}
    </button>
  );
}

/** A shell command the operator is meant to run, ready to copy. */
export function Command({ text }: { text: string }) {
  return (
    <code className="inline-flex select-all items-center gap-2 rounded-[4px] border border-ink-600 bg-ink-950/70 px-2 py-1.5 font-mono text-[11.5px] text-haze-200">
      <span className="text-haze-700 select-none">$</span>
      {text}
    </code>
  );
}
