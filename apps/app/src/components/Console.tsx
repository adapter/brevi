import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RunEvent } from "@brevi/shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Collapsible as CollapsibleRoot,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { toAgentBlocks, type AgentBlock } from "../lib/agent";
import { bytes, clock, oneLine } from "../lib/format";
import { STATUS_TONE } from "../lib/status";
import { Plate } from "./Bits";
import { Pin } from "./Icons";

export function Console({
  runId,
  events,
  live,
}: {
  runId: string;
  events: RunEvent[];
  live: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);

  // Reset the viewport when the operator opens a different run.
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

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 28;
    setStick(atBottom);
  };

  return (
    <Card className="flex max-h-[clamp(320px,52vh,680px)] min-h-[180px] flex-col gap-0 overflow-hidden py-0">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-ink-700 bg-ink-800/60 px-3">
        <Plate className="text-haze-400">Console</Plate>
        <span className="font-mono text-[11px] leading-none text-haze-700">{events.length}</span>
        {live && (
          <span className="inline-flex items-center gap-1.5 text-ember-500">
            <span className="inline-block size-[6px] animate-beacon rounded-[1.5px] bg-ember-500 text-ember-500" />
            <span className="plate">Streaming</span>
          </span>
        )}
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
      </div>

      <div
        ref={scroller}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto scroll-smooth px-3 py-2.5"
      >
        {events.length === 0 ? (
          <p className="px-1 py-6 text-center font-mono text-[11.5px] text-haze-700">
            {live ? "Waiting for the sandbox to say something…" : "No output was recorded."}
          </p>
        ) : (
          <div className="flex flex-col">
            {events.map((event, i) => (
              <Row key={`${event.ts}-${i}`} event={event} />
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function Row({ event }: { event: RunEvent }) {
  if (event.type === "status") {
    const tone = STATUS_TONE[event.status];
    return (
      <div className="my-1.5 flex items-center gap-2.5">
        <Gutter ts={event.ts} />
        <span className={`plate ${tone.fg}`}>{tone.label}</span>
        <span className="h-px flex-1 bg-ink-700" />
      </div>
    );
  }

  if (event.type === "artifact") {
    return (
      <div className="flex gap-2.5 py-[3px]">
        <Gutter ts={event.ts} />
        <p className="min-w-0 font-mono text-[11.5px] text-haze-600">
          captured {event.artifact.type}{" "}
          <span className="text-haze-300">{event.artifact.name}</span>{" "}
          <span className="text-haze-700">{bytes(event.artifact.size)}</span>
        </p>
      </div>
    );
  }

  if (event.type === "log") {
    const styles = {
      stdout: "text-haze-200",
      stderr: "text-rust-400",
      system: "text-peri-400/85",
    } as const;
    return (
      <div className="flex gap-2.5 py-[1px]">
        <Gutter ts={event.ts} />
        <pre
          className={`min-w-0 flex-1 font-mono text-[11.5px] leading-[1.55] break-words whitespace-pre-wrap ${styles[event.stream]}`}
        >
          {event.stream === "system" ? `· ${event.text}` : event.text}
        </pre>
      </div>
    );
  }

  const blocks = toAgentBlocks(event.event);
  return (
    <div className="flex flex-col">
      {blocks.map((block, i) => (
        <div key={i} className="flex gap-2.5 py-[2px]">
          <Gutter ts={i === 0 ? event.ts : undefined} />
          <div className="min-w-0 flex-1">
            <Block block={block} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Gutter({ ts }: { ts?: string }) {
  return (
    <span className="w-[58px] shrink-0 pt-[3px] text-right font-mono text-[10px] leading-[1.55] tabular-nums text-haze-600 select-none">
      {ts ? clock(ts) : ""}
    </span>
  );
}

function Block({ block }: { block: AgentBlock }) {
  switch (block.kind) {
    case "text":
      return (
        <div className="my-1 border-l-2 border-iris-400/40 pl-3">
          <Plate className="text-iris-400/70">Agent</Plate>
          <p className="mt-1 text-[13px] leading-relaxed break-words whitespace-pre-wrap text-haze-50">
            {block.text}
          </p>
        </div>
      );

    case "thinking":
      return (
        <Collapsible
          summary={
            <>
              <span className="plate text-haze-700">Thinking</span>
              <span className="truncate font-mono text-[11px] text-haze-700 italic">
                {oneLine(block.text, 90)}
              </span>
            </>
          }
        >
          <p className="text-[12px] leading-relaxed whitespace-pre-wrap text-haze-400 italic">
            {block.text}
          </p>
        </Collapsible>
      );

    case "tool":
      return (
        <Collapsible
          summary={
            <>
              <span className="plate rounded-[3px] bg-ink-750 px-1.5 py-1 text-haze-300">
                {block.name}
              </span>
              <span className="truncate font-mono text-[11.5px] text-haze-400">{block.target}</span>
            </>
          }
        >
          <pre className="font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-haze-400">
            {block.detail}
          </pre>
        </Collapsible>
      );

    case "tool-result":
      return (
        <Collapsible
          summary={
            <>
              <span className={`plate ${block.ok ? "text-haze-700" : "text-rust-400"}`}>
                {block.ok ? "Result" : "Result failed"}
              </span>
              <span
                className={`truncate font-mono text-[11px] ${block.ok ? "text-haze-600" : "text-rust-400/80"}`}
              >
                {oneLine(block.text, 100)}
              </span>
            </>
          }
        >
          <pre className="max-h-64 overflow-auto font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-haze-400">
            {block.text}
          </pre>
        </Collapsible>
      );

    case "result":
      return (
        <div
          className={`my-1.5 rounded-[5px] border px-3 py-2 ${
            block.ok
              ? "border-mint-500/30 bg-mint-500/8"
              : "border-rust-500/35 bg-rust-500/8"
          }`}
        >
          <div className="flex items-center gap-2">
            <span className={`plate ${block.ok ? "text-mint-400" : "text-rust-400"}`}>
              {block.ok ? "Agent finished" : "Agent stopped"}
            </span>
            {block.detail && (
              <span className="font-mono text-[10.5px] text-haze-600">{block.detail}</span>
            )}
          </div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed whitespace-pre-wrap text-haze-200">
            {block.text}
          </p>
        </div>
      );

    default:
      return (
        <p className="truncate font-mono text-[11px] leading-[1.55] text-haze-700">{block.text}</p>
      );
  }
}

function Collapsible({
  summary,
  children,
}: {
  summary: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <CollapsibleRoot>
      <CollapsibleTrigger className="group/row flex w-full cursor-pointer items-center gap-2 rounded-[3px] py-[2px] text-left hover:bg-ink-800">
        <span className="w-2.5 shrink-0 text-center font-mono text-[9px] text-haze-700 transition-transform group-data-[panel-open]/row:rotate-90">
          ▸
        </span>
        {summary}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 mb-1.5 ml-[18px] border-l border-ink-600 pl-3">
        {children}
      </CollapsibleContent>
    </CollapsibleRoot>
  );
}
