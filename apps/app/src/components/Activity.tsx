import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RunEvent } from "@brevi/shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  toActivity,
  type ActivityItem,
  type FileChange,
  type TodoItem,
} from "../lib/activity";
import { clock, elapsed, oneLine } from "../lib/format";
import { STATUS_TONE } from "../lib/status";
import { Plate } from "./Bits";
import { DiffTable } from "./Diff";
import { Check, ChevronRight, Doc, Pin, Terminal as TerminalIcon } from "./Icons";

/**
 * The run's activity feed: what the agent said, thought, edited, and ran,
 * drawn the way a coding agent's own desktop app draws it. File edits render
 * as real diffs; commands carry their output behind a disclosure; everything
 * else is one quiet row. The raw stream stays available in the Raw tab.
 */
export function Activity({
  runId,
  events,
  live,
}: {
  runId: string;
  events: RunEvent[];
  live: boolean;
}) {
  const items = useMemo(() => toActivity(events), [events]);

  const scroller = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const stickRef = useRef(true);
  useEffect(() => {
    stickRef.current = stick;
  }, [stick]);
  // A resize restore is in flight: its scroll event is not the operator
  // scrolling away, so it must not turn follow mode off.
  const restoring = useRef(false);

  useEffect(() => {
    setStick(true);
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [runId]);

  useLayoutEffect(() => {
    if (!stick) return;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length, stick]);

  const restoreFollow = () => {
    const el = scroller.current;
    if (!el || !stickRef.current) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 1) return;
    restoring.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
  };

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      restoreFollow();
      requestAnimationFrame(restoreFollow);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 28;
    if (restoring.current) {
      restoring.current = false;
      if (atBottom) return;
    }
    setStick(atBottom);
  };

  // The last thought still awaiting its finish gets the live spinner.
  const spinnerIndex = useMemo(() => {
    if (!live) return -1;
    let pending = -1;
    items.forEach((item, i) => {
      if (item.kind === "thought") pending = item.pending ? i : -1;
    });
    return pending;
  }, [items, live]);

  return (
    <Card className="flex h-full min-h-[320px] flex-col gap-0 overflow-hidden py-0">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-ink-700 bg-ink-800/60 px-3">
        <Plate className="text-haze-400">Activity</Plate>
        {live && (
          <>
            <span className="inline-flex items-center gap-1.5 text-ember-500">
              <span className="inline-block size-[6px] animate-beacon rounded-full bg-ember-500" />
              <span className="plate">Streaming</span>
            </span>
            <Button
              size="plate"
              variant={stick ? "outline" : "default"}
              onClick={() => {
                setStick(true);
                const el = scroller.current;
                if (el) el.scrollTop = el.scrollHeight;
              }}
              aria-pressed={stick}
              className={stick ? "ml-auto bg-ink-750" : "ml-auto"}
            >
              <Pin className="size-3" />
              {stick ? "Following" : "Jump to latest"}
            </Button>
          </>
        )}
      </div>

      <div
        ref={scroller}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto scroll-smooth px-4 py-3"
      >
        {items.length === 0 ? (
          <p className="px-1 py-6 text-center font-mono text-[11.5px] text-haze-700">
            {live ? "Waiting for the agent to start…" : "No activity was recorded."}
          </p>
        ) : (
          <div className="flex flex-col">
            {items.map((item, i) => (
              <Item key={`${item.ts}-${i}`} item={item} spinner={i === spinnerIndex} />
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function Item({ item, spinner }: { item: ActivityItem; spinner: boolean }) {
  switch (item.kind) {
    case "message":
      return (
        <p
          className="my-1.5 max-w-[72ch] text-[13px] leading-relaxed break-words whitespace-pre-wrap text-haze-100"
          title={clock(item.ts)}
        >
          {item.text}
        </p>
      );

    case "thought": {
      if (spinner) return <ThinkingRow durationMs={item.durationMs} since={item.pendingSince} />;
      if (item.pending && item.durationMs === 0) return null;
      return (
        <p className="my-1 text-[12px] text-haze-600 italic" title={clock(item.ts)}>
          Thought for {elapsed(Math.max(1000, item.durationMs))}
        </p>
      );
    }

    case "edit":
      return (
        <div className="my-1.5 flex flex-col gap-1.5" title={clock(item.ts)}>
          {item.changes.map((change, i) => (
            <EditCard key={i} change={change} ok={item.ok} />
          ))}
          {item.error && (
            <p className="rounded-md bg-rust-500/10 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-rust-400">
              {oneLine(item.error, 300)}
            </p>
          )}
        </div>
      );

    case "command":
      return <CommandBlock item={item} />;

    case "action":
      return <ActionRow item={item} />;

    case "todos":
      return <TodoList ts={item.ts} todos={item.todos} />;

    case "status": {
      const tone = STATUS_TONE[item.status];
      return (
        <div className="my-2 flex items-center gap-2.5" title={clock(item.ts)}>
          <span className={`plate ${tone.fg}`}>{tone.label}</span>
          <span className="h-px flex-1 bg-ink-700" />
          <span className="font-mono text-[10px] text-haze-700 tabular-nums">{clock(item.ts)}</span>
        </div>
      );
    }

    case "attempt":
      return (
        <div className="my-2 flex items-center gap-2.5" title={clock(item.ts)}>
          <span className="plate text-iris-400">Attempt {item.number}</span>
          <span className="h-px flex-1 bg-ink-700" />
          <span className="font-mono text-[10px] text-haze-700 tabular-nums">{clock(item.ts)}</span>
        </div>
      );

    case "limit": {
      const provider =
        item.limit.provider === "claude"
          ? "Claude"
          : item.limit.provider === "grok"
            ? "Grok"
            : "Codex";
      const kind = item.limit.kind === "unknown" ? "usage limit" : `${item.limit.kind} limit`;
      return (
        <p className="my-1 font-mono text-[11.5px] text-haze-600" title={clock(item.ts)}>
          hit {provider} <span className="text-haze-300">{kind}</span>
          {item.limit.resetsAt && (
            <span className="text-haze-700"> · resets {clock(item.limit.resetsAt)}</span>
          )}
        </p>
      );
    }

    case "artifact":
      return (
        <p className="my-1 font-mono text-[11.5px] text-haze-600" title={clock(item.ts)}>
          captured {item.type} <span className="text-haze-300">{item.name}</span>
        </p>
      );

    case "outcome":
      return (
        <div
          className={`my-2 rounded-lg border px-3 py-2 ${
            item.ok ? "border-mint-500/30 bg-mint-500/8" : "border-rust-500/35 bg-rust-500/8"
          }`}
          title={clock(item.ts)}
        >
          <div className="flex items-center gap-2">
            <span className={`plate ${item.ok ? "text-mint-400" : "text-rust-400"}`}>
              {item.ok ? "Agent finished" : "Agent stopped"}
            </span>
            {item.detail && (
              <span className="font-mono text-[10.5px] text-haze-600">{item.detail}</span>
            )}
          </div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed whitespace-pre-wrap text-haze-200">
            {item.text}
          </p>
        </div>
      );

    default:
      return null;
  }
}

/** The live spinner row, ticking once a second: "Thinking… 23s". */
function ThinkingRow({ durationMs, since }: { durationMs: number; since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const ms = durationMs + Math.max(0, now - since);
  return (
    <span className="my-1 flex items-center gap-2">
      <span className="size-3 shrink-0 animate-spin rounded-full border border-haze-600 border-t-transparent" />
      <span className="text-[12px] text-haze-500 italic tabular-nums">
        Thinking… {elapsed(Math.max(1000, ms))}
      </span>
    </span>
  );
}

/** How many diff lines show before the card folds the rest behind a button. */
const DIFF_PREVIEW_LINES = 18;

function EditCard({ change, ok }: { change: FileChange; ok: boolean | undefined }) {
  const [expanded, setExpanded] = useState(false);
  const lines = expanded ? change.diff : change.diff.slice(0, DIFF_PREVIEW_LINES);
  const hidden = change.diff.length - lines.length;
  const verb =
    change.verb === "write"
      ? "Wrote"
      : change.verb === "delete"
        ? "Deleted"
        : change.verb === "rename"
          ? "Renamed"
          : "Edited";

  return (
    <div className="overflow-hidden rounded-lg ring-1 ring-foreground/10">
      <div className="flex items-center gap-2 bg-ink-800/60 px-3 py-1.5">
        <Doc className="size-3.5 shrink-0 text-haze-600" />
        <span className="min-w-0 truncate font-mono text-[11.5px] text-haze-200" title={change.path}>
          {change.path || verb.toLowerCase()}
        </span>
        {ok === false && <span className="plate shrink-0 text-rust-400">Failed</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] tabular-nums">
          {change.additions > 0 && <span className="text-mint-400">+{change.additions}</span>}
          {change.deletions > 0 && <span className="text-rust-400">-{change.deletions}</span>}
          {change.additions === 0 && change.deletions === 0 && (
            <span className="text-haze-600">{verb}</span>
          )}
        </span>
      </div>
      {lines.length > 0 && <DiffTable lines={lines} />}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="block w-full cursor-pointer border-t border-ink-700/60 bg-ink-850 px-3 py-1 text-left font-mono text-[10.5px] text-haze-500 transition-colors hover:text-haze-200"
        >
          Show {hidden} more {hidden === 1 ? "line" : "lines"}
        </button>
      )}
    </div>
  );
}

function CommandBlock({ item }: { item: Extract<ActivityItem, { kind: "command" }> }) {
  const failed = item.ok === false;
  return (
    <div
      className={`my-1.5 overflow-hidden rounded-lg ring-1 ${failed ? "ring-rust-500/35" : "ring-foreground/10"}`}
      title={clock(item.ts)}
    >
      <div className="flex items-start gap-2 bg-ink-800/60 px-3 py-1.5">
        <TerminalIcon className="mt-[3px] size-3.5 shrink-0 text-haze-600" />
        <code className="min-w-0 flex-1 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-haze-200">
          {item.command}
        </code>
        {item.running ? (
          <span className="mt-[2px] size-3 shrink-0 animate-spin rounded-full border border-haze-600 border-t-transparent" />
        ) : failed ? (
          <span className="plate mt-[2px] shrink-0 text-rust-400">Failed</span>
        ) : null}
      </div>
      {item.description && !item.output && (
        <p className="border-t border-ink-700/60 bg-ink-900/60 px-3 py-1 font-mono text-[10.5px] text-haze-600">
          {item.description}
        </p>
      )}
      {item.output && (
        <Collapsible defaultOpen={failed}>
          <CollapsibleTrigger className="group/out flex w-full cursor-pointer items-center gap-1.5 border-t border-ink-700/60 bg-ink-850 px-3 py-1 text-left transition-colors hover:bg-ink-800">
            <ChevronRight className="size-2.5 text-haze-700 transition-transform group-data-[panel-open]/out:rotate-90" />
            <span className="min-w-0 truncate font-mono text-[10.5px] text-haze-500">
              {oneLine(item.output, 90)}
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre
              className={`max-h-72 overflow-auto border-t border-ink-700/60 bg-ink-900/60 px-3 py-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap ${
                failed ? "text-rust-400/90" : "text-haze-400"
              }`}
            >
              {item.output}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

function ActionRow({ item }: { item: Extract<ActivityItem, { kind: "action" }> }) {
  const failed = item.ok === false;
  const body = [item.detail, item.result].filter(Boolean).join("\n\n");
  const summary = (
    <>
      <span className={`plate shrink-0 ${failed ? "text-rust-400" : "text-haze-500"}`}>
        {item.label}
      </span>
      <span
        className={`min-w-0 truncate font-mono text-[11.5px] ${failed ? "text-rust-400/80" : "text-haze-400"}`}
      >
        {item.target}
      </span>
    </>
  );

  if (!body) {
    return (
      <div className="flex items-center gap-2 py-[3px] pl-[18px]" title={clock(item.ts)}>
        {summary}
      </div>
    );
  }
  return (
    <Collapsible>
      <CollapsibleTrigger
        className="group/act flex w-full cursor-pointer items-center gap-2 rounded-[3px] py-[3px] text-left hover:bg-ink-800"
        title={clock(item.ts)}
      >
        <ChevronRight className="size-2.5 shrink-0 text-haze-700 transition-transform group-data-[panel-open]/act:rotate-90" />
        {summary}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 mb-1.5 ml-[5px] border-l border-ink-600 pl-3">
        <pre className="max-h-64 overflow-auto font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-haze-400">
          {body}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

function TodoList({ ts, todos }: { ts: string; todos: TodoItem[] }) {
  return (
    <div className="my-1.5 rounded-lg bg-ink-850/70 px-3 py-2 ring-1 ring-foreground/10" title={clock(ts)}>
      <Plate className="text-haze-600">Plan</Plate>
      <ul className="mt-1.5 flex flex-col gap-1">
        {todos.map((todo, i) => (
          <li key={i} className="flex items-start gap-2 text-[12px] leading-snug">
            {todo.state === "completed" ? (
              <Check className="mt-[2px] size-3 shrink-0 text-mint-400" />
            ) : todo.state === "in_progress" ? (
              <span className="mt-[4px] inline-block size-2 shrink-0 animate-beacon rounded-full bg-ember-500" />
            ) : (
              <span className="mt-[4px] inline-block size-2 shrink-0 rounded-full border border-haze-600" />
            )}
            <span
              className={
                todo.state === "completed"
                  ? "text-haze-600 line-through decoration-haze-700"
                  : todo.state === "in_progress"
                    ? "text-haze-100"
                    : "text-haze-400"
              }
            >
              {todo.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
