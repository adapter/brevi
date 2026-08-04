import type { Run } from "@brevi/shared";
import { duration, relative } from "../lib/format";
import { STATUS_TONE, isActive } from "../lib/status";
import { Command, Plate, StatusDot } from "./Bits";
import { ChevronRight } from "./Icons";
import type { Connection } from "../lib/useOrchestrator";

export function RunsList({
  runs,
  now,
  conn,
  loaded,
  onOpen,
}: {
  runs: Run[];
  now: number;
  conn: Connection;
  loaded: boolean;
  onOpen: (runId: string) => void;
}) {
  const active = runs.filter((r) => isActive(r.status)).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-ink-700/70 px-4">
        <Plate className="text-haze-400">Runs</Plate>
        <span className="font-mono text-[11px] leading-none text-haze-700">{runs.length}</span>
        {active > 0 && (
          <span className="ml-1 inline-flex items-center gap-1.5 text-ember-500">
            <StatusDot status="running" size={6} />
            <span className="plate">{active} active</span>
          </span>
        )}
        <span className="ml-auto">
          <Plate className="text-haze-700">Newest first</Plate>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {runs.length === 0 ? (
          <NoRuns conn={conn} loaded={loaded} />
        ) : (
          <ul className="flex flex-col gap-px p-3">
            {runs.map((run) => (
              <li key={run.id}>
                <RunRow run={run} now={now} onOpen={() => onOpen(run.id)} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function RunRow({ run, now, onOpen }: { run: Run; now: number; onOpen: () => void }) {
  const tone = STATUS_TONE[run.status];
  const live = isActive(run.status);
  const span = live
    ? duration(run.startedAt ?? run.createdAt, now)
    : run.finishedAt && run.startedAt
      ? duration(run.startedAt, Date.parse(run.finishedAt))
      : "—";

  return (
    <button
      type="button"
      onClick={onOpen}
      className="strip flex w-full items-center gap-3 overflow-hidden py-2.5 pr-2.5 text-left hover:border-ink-500 hover:bg-ink-800"
    >
      <span className={`-my-2.5 w-[3px] shrink-0 self-stretch ${tone.fill}`} aria-hidden="true" />

      <span className={`flex w-[86px] shrink-0 items-center gap-2 ${tone.fg}`}>
        <StatusDot status={run.status} size={7} />
        <span className="plate truncate">{tone.label}</span>
      </span>

      <span className="w-[74px] shrink-0 truncate font-plate text-[10px] tracking-[0.06em] text-haze-300">
        {run.ticket.identifier}
      </span>

      <span className="min-w-0 flex-1 truncate text-[13px] text-haze-50">{run.ticket.title}</span>

      {run.ticket.kind === "spike" && (
        <span className="plate hidden shrink-0 rounded-[3px] border border-iris-400/30 bg-iris-400/10 px-1.5 py-1 text-iris-400 sm:inline-block">
          Spike
        </span>
      )}

      {run.ticket.repo && (
        <span className="hidden shrink-0 font-mono text-[11px] text-haze-600 md:inline">
          {run.ticket.repo}
        </span>
      )}

      <span className="hidden shrink-0 xl:inline">
        <Plate className="text-haze-700">{run.sandbox.provider}</Plate>
      </span>

      <span className="w-[62px] shrink-0 text-right font-mono text-[11px] tabular-nums text-haze-300">
        {span}
      </span>

      <span className="hidden w-[66px] shrink-0 text-right font-mono text-[11px] text-haze-700 sm:inline">
        {relative(run.createdAt, now)}
      </span>

      <ChevronRight className="size-3.5 shrink-0 text-haze-700" />
    </button>
  );
}

function NoRuns({ conn, loaded }: { conn: Connection; loaded: boolean }) {
  if (conn === "offline" && !loaded) {
    return (
      <div className="flex justify-center px-8 pt-[11vh]">
        <div className="panel max-w-md p-5">
          <span className="inline-flex items-center gap-2 text-rust-400">
            <span className="inline-block size-[7px] rounded-full bg-rust-500" />
            <Plate>Orchestrator offline</Plate>
          </span>
          <h2 className="mt-2.5 text-[15px] text-haze-50">Nothing is listening on this port</h2>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-haze-400">
            The dashboard talks to a brevi orchestrator running on your machine. Start one and this
            page reconnects on its own.
          </p>
          <div className="mt-3.5">
            <Command text="npx @brevi/cli ui" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-center px-8 pt-[13vh]">
      <div className="max-w-sm text-center">
        <p className="text-[13.5px] text-haze-300">No runs yet</p>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-haze-600">
          Run a ticket from the queue, or leave brevi to pick one up on its next pass through
          Linear. Everything it does shows up here.
        </p>
      </div>
    </div>
  );
}
