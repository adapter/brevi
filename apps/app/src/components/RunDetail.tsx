import type { LimitInfo, Run, RunEvent } from "@brevi/shared";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { clock, elapsed, relative } from "../lib/format";
import { isActive } from "../lib/status";
import { Artifacts } from "./Artifacts";
import { KindChip, Plate, RepoChip, StatusChip } from "./Bits";
import { Console } from "./Console";
import { CostBadge } from "./CostBadge";
import { Check, Copy, External, Play, Stop, Terminal } from "./Icons";
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
  const finished = run.status === "completed" || run.status === "failed";
  const retainedMs = run.sandbox.retainedUntil ? Date.parse(run.sandbox.retainedUntil) : Number.NaN;
  const sandboxRetained = retainedMs > now;
  const resumable = finished && sandboxRetained && Boolean(run.agentSessionId);
  const [showAttach, setShowAttach] = useState(false);
  const artifacts = run.result?.artifacts ?? collectArtifacts(events);
  const hasResult = Boolean(run.result);
  const hasArtifacts = artifacts.length > 0;
  const shipped = run.status === "completed";

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
          <CostBadge costs={run.costs} totals={run.costTotals} align="end" className="text-[11px]" />
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
          {finished &&
            (resumable ? (
              <Button variant="outline" size="plate" onClick={() => setShowAttach((v) => !v)}>
                <Terminal className="size-3" />
                Continue in CLI
              </Button>
            ) : (
              <Button
                variant="outline"
                size="plate"
                disabled
                title={
                  !sandboxRetained
                    ? "The run's sandbox is no longer available; it was cleaned up when the retention window ended."
                    : "No agent session was captured for this run; resume supports Claude runs only."
                }
              >
                <Terminal className="size-3" />
                {!sandboxRetained ? "Sandbox expired" : "Resume unavailable"}
              </Button>
            ))}
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

          {resumable && showAttach && (
            <AttachBanner runId={run.id} retainedUntil={run.sandbox.retainedUntil as string} now={now} />
          )}

          <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
            <div className="flex min-w-0 flex-col gap-4">
              <PhaseSpine run={run} events={events} now={now} />

              <Console runId={run.id} events={events} live={live} />
            </div>

            <aside className="min-w-0 xl:sticky xl:top-14 xl:max-h-[calc(100svh-8.5rem)] xl:overflow-y-auto">
              <Card
                className={`block animate-rise border-l-2 ${
                  hasResult && shipped ? "border-mint-500/30" : "border-ink-700"
                } p-4`}
              >
                <ResultCard run={run} />

                {hasResult && hasArtifacts && <Separator className="my-4" />}

                <Artifacts runId={run.id} artifacts={artifacts} />

                {!hasResult && !hasArtifacts && (
                  <div>
                    <Plate className="text-haze-700">Output</Plate>
                    <p className="mt-2 text-[12.5px] leading-relaxed text-haze-600">
                      Results and evidence appear here as the run produces them.
                    </p>
                  </div>
                )}
              </Card>
            </aside>
          </div>
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

/** The run is finished but its sandbox is still retained; hand over the CLI command to resume it. */
function AttachBanner({
  runId,
  retainedUntil,
  now,
}: {
  runId: string;
  retainedUntil: string;
  now: number;
}) {
  const [copied, setCopied] = useState(false);
  const command = `brevi attach ${runId}`;
  const retainedMs = Date.parse(retainedUntil);

  function onCopy() {
    void navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="rounded-[5px] border border-ink-700/70 bg-ink-800/40 p-3">
      <span className="plate text-haze-200">Continue this run in your terminal</span>
      <p className="mt-1.5 font-mono text-[11px] leading-relaxed text-haze-600">
        Boots the run's sandbox with the checkout, dependencies, and credentials still in place, and
        resumes the agent conversation.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <code className="flex-1 truncate rounded-[4px] border border-ink-700 bg-ink-900 px-2.5 py-1.5 font-mono text-[11px] text-haze-200">
          {command}
        </code>
        <Button variant="outline" size="plate" onClick={onCopy}>
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="mt-1.5 font-mono text-[11px] text-haze-700">
        Sandbox available until {clock(retainedUntil)} (in {elapsed(retainedMs - now)})
      </p>
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
