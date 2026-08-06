import type { LimitInfo, Run, RunEvent } from "@brevi/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { clock, elapsed, relative } from "../lib/format";
import { isActive } from "../lib/status";
import { Artifacts } from "./Artifacts";
import { KindChip, RepoChip, StatusChip } from "./Bits";
import { Console } from "./Console";
import { External, Play, Stop } from "./Icons";
import { PhaseSpine } from "./PhaseSpine";
import { ResultCard } from "./ResultCard";

export function RunDetail({
  run,
  repoName,
  events,
  now,
  busy,
  onCancel,
  onRetry,
}: {
  run: Run;
  /** owner/name of the mapped repo, resolved from config. */
  repoName: string | undefined;
  events: RunEvent[];
  now: number;
  busy: boolean;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const live = isActive(run.status);
  const retryable = run.status === "failed" || run.status === "cancelled";
  const artifacts = run.result?.artifacts ?? collectArtifacts(events);

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-ink-700/70 bg-ink-900/90 px-4 py-2 backdrop-blur-md">
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
            <Button variant="destructive" size="plate" onClick={onCancel} disabled={busy}>
              <Stop className="size-3" />
              {busy ? "Cancelling" : "Cancel run"}
            </Button>
          )}
          {retryable && (
            <Button variant="outline" size="plate" onClick={onRetry} disabled={busy}>
              <Play className="size-3" />
              {busy ? "Retrying" : "Retry run"}
            </Button>
          )}
        </span>
      </div>

      <div>
        <div className="flex flex-col gap-4 p-4">
          <div>
            <h2 className="text-[17px] leading-snug font-medium text-haze-50">
              {run.ticket.title}
            </h2>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <RepoChip repo={repoName} />
              <Badge variant="secondary">
                <span className="text-haze-700">State</span>
                <span className="font-mono text-[11px] leading-none tracking-normal normal-case text-haze-300">
                  {run.ticket.state}
                </span>
              </Badge>
              {run.ticket.labels.slice(0, 4).map((label) => (
                <Badge
                  key={label}
                  variant="outline"
                  className="border-ink-700 font-mono text-[10.5px] tracking-normal normal-case"
                >
                  {label}
                </Badge>
              ))}
            </div>
          </div>

          {run.status === "waiting" && (
            <WaitingBanner
              limit={run.limit}
              resumeAt={run.resumeAt}
              attempts={run.attempts.length}
              now={now}
              busy={busy}
              onResume={onRetry}
            />
          )}

          <PhaseSpine run={run} events={events} now={now} />

          <Console runId={run.id} events={events} live={live} />

          <ResultCard run={run} />

          <Artifacts runId={run.id} artifacts={artifacts} />
        </div>
      </div>
    </div>
  );
}

/** The run is parked on an agent usage limit; say why, until when, and offer to skip the wait. */
function WaitingBanner({
  limit,
  resumeAt,
  attempts,
  now,
  busy,
  onResume,
}: {
  limit: LimitInfo | undefined;
  resumeAt: string | undefined;
  attempts: number;
  now: number;
  busy: boolean;
  onResume: () => void;
}) {
  const resumeMs = resumeAt ? Date.parse(resumeAt) : Number.NaN;
  const eta = Number.isNaN(resumeMs)
    ? "soon"
    : resumeMs > now
      ? `at ${clock(resumeAt as string)} (in ${elapsed(resumeMs - now)})`
      : "any moment now";
  return (
    <div className="rounded-[5px] border border-iris-400/35 bg-iris-400/8 p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="plate text-iris-400">{limit ? limitLabel(limit) : "Usage limit reached"}</span>
        <span className="font-mono text-[11px] text-haze-400">
          attempt {attempts + 1} starts {eta}
        </span>
        <Button
          variant="outline"
          size="plate"
          onClick={onResume}
          disabled={busy}
          className="ml-auto"
        >
          <Play className="size-3" />
          {busy ? "Resuming" : "Resume now"}
        </Button>
      </div>
      {limit?.message && (
        <p className="mt-1.5 font-mono text-[11px] leading-relaxed break-words text-haze-600">
          {limit.message}
        </p>
      )}
    </div>
  );
}

function limitLabel(limit: LimitInfo): string {
  const provider = limit.provider === "claude" ? "Claude" : "Codex";
  const kind = limit.kind === "unknown" ? "usage limit" : `${limit.kind} limit`;
  return `${provider} ${kind} reached`;
}

/** Before a run finishes there is no result, but artifact events still arrive. */
function collectArtifacts(events: RunEvent[]) {
  const seen = new Map<string, RunEvent & { type: "artifact" }>();
  for (const e of events) if (e.type === "artifact") seen.set(e.artifact.name, e);
  return [...seen.values()].map((e) => e.artifact);
}
