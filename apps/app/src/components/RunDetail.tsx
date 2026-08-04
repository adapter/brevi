import type { Run, RunEvent } from "@brevi/shared";
import { relative } from "../lib/format";
import { isActive } from "../lib/status";
import { Artifacts } from "./Artifacts";
import { Button, KindChip, Plate, RepoChip, StatusChip } from "./Bits";
import { Console } from "./Console";
import { ArrowLeft, External, Stop } from "./Icons";
import { PhaseSpine } from "./PhaseSpine";
import { ResultCard } from "./ResultCard";

export function RunDetail({
  run,
  events,
  now,
  busy,
  onBack,
  onCancel,
}: {
  run: Run;
  events: RunEvent[];
  now: number;
  busy: boolean;
  onBack: () => void;
  onCancel: () => void;
}) {
  const live = isActive(run.status);
  const artifacts = run.result?.artifacts ?? collectArtifacts(events);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-ink-700/70 px-4 py-2">
        <button
          type="button"
          onClick={onBack}
          className="plate inline-flex items-center gap-1.5 rounded-[4px] border border-ink-600 px-2 py-1.5 text-haze-400 transition-colors hover:bg-ink-750 hover:text-haze-50"
        >
          <ArrowLeft className="size-3" />
          Runs
        </button>

        <a
          href={run.ticket.url}
          target="_blank"
          rel="noreferrer"
          className="group inline-flex items-center gap-1.5 font-plate text-[11px] tracking-[0.06em] text-haze-200 hover:text-haze-50"
        >
          {run.ticket.identifier}
          <External className="size-3 text-haze-700 transition-colors group-hover:text-haze-300" />
        </a>

        <KindChip kind={run.ticket.kind} />
        <StatusChip status={run.status} />

        <span className="ml-auto flex items-center gap-2.5">
          <span className="hidden font-mono text-[11px] text-haze-700 sm:inline">
            started {relative(run.startedAt ?? run.createdAt, now)}
          </span>
          {live && (
            <Button tone="rust" onClick={onCancel} disabled={busy}>
              <Stop className="size-3" />
              {busy ? "Cancelling" : "Cancel run"}
            </Button>
          )}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-4 p-4">
          <div>
            <h2 className="text-[17px] leading-snug font-medium text-haze-50">
              {run.ticket.title}
            </h2>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <RepoChip repo={run.ticket.repo} />
              <span className="inline-flex items-center gap-1.5 rounded-[4px] border border-ink-600 bg-ink-800 px-1.5 py-1">
                <Plate className="text-haze-700">State</Plate>
                <span className="font-mono text-[11px] leading-none text-haze-300">
                  {run.ticket.state}
                </span>
              </span>
              {run.ticket.labels.slice(0, 4).map((label) => (
                <span
                  key={label}
                  className="rounded-[4px] border border-ink-700 px-1.5 py-1 font-mono text-[10.5px] leading-none text-haze-600"
                >
                  {label}
                </span>
              ))}
            </div>
          </div>

          <PhaseSpine run={run} events={events} now={now} />

          <Console runId={run.id} events={events} live={live} />

          <ResultCard run={run} />

          <Artifacts runId={run.id} artifacts={artifacts} />
        </div>
      </div>
    </div>
  );
}

/** Before a run finishes there is no result, but artifact events still arrive. */
function collectArtifacts(events: RunEvent[]) {
  const seen = new Map<string, RunEvent & { type: "artifact" }>();
  for (const e of events) if (e.type === "artifact") seen.set(e.artifact.name, e);
  return [...seen.values()].map((e) => e.artifact);
}
