import type { LimitInfo, PrState, PrStatusResponse, Run, RunEvent, WorkerView } from "@brevi/shared";
import { summarizeCosts } from "@brevi/shared/types";
import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api } from "../lib/api";
import { clock, duration, elapsed } from "../lib/format";
import { isActive, isTerminal } from "../lib/status";
import { Artifacts } from "./Artifacts";
import { AttachTerminal } from "./AttachTerminal";
import { Plate, PrChip, RepoChip, StatusChip } from "./Bits";
import { Console } from "./Console";
import { CostBadge, CostBreakdown } from "./CostBadge";
import { External, Play, Refresh, Stop } from "./Icons";
import { ResultCard } from "./ResultCard";

export function RunDetail({
  run,
  repoName,
  workers,
  events,
  now,
  busy,
  onCancel,
  onRetry,
  onFollowUp,
}: {
  run: Run;
  /** owner/name of the mapped repo, resolved from config. */
  repoName: string | undefined;
  /** The enrolled fleet, to resolve run.sandbox.workerId to a human name. */
  workers: WorkerView[];
  events: RunEvent[];
  now: number;
  busy: boolean;
  onCancel: () => void;
  onRetry: () => void;
  onFollowUp: () => void | Promise<void>;
}) {
  const live = isActive(run.status);
  const hasOutcome = isTerminal(run.status) || Boolean(run.result || run.error);
  const retryable = run.status === "failed" || run.status === "cancelled";
  // The header chip renders from the run-level PR metadata streamed by the
  // orchestrator's background poll; the follow-up button below keeps its own
  // fresher 30s probe.
  const prChipUrl = run.prUrl;
  const prChipState = prChipUrl ? (run.prState ?? "open") : undefined;
  const finished = run.status === "completed" || run.status === "failed";
  const retainedMs = run.sandbox.retainedUntil ? Date.parse(run.sandbox.retainedUntil) : Number.NaN;
  const sandboxRetained = retainedMs > now;
  const resumable = finished && sandboxRetained && Boolean(run.agentSessionId);
  // A retry clears run.result, so an active run still carrying its PR result is a follow-up in flight.
  const followUpInFlight = live && Boolean(run.result?.prUrl);
  // Completed runs, plus failed or cancelled follow-ups: those keep their PR
  // result (a retry clears it), so "Take another look" can run again instead
  // of forcing a retry that redoes the whole ticket.
  const followUpReady = isTerminal(run.status) && Boolean(run.result?.prUrl);
  const [prState, setPrState] = useState<"unknown" | PrState>("unknown");
  const [probeTick, setProbeTick] = useState(0);
  // Switching runs hides the button until the probe below confirms the new
  // run's PR is open again.
  useEffect(() => {
    setPrState("unknown");
  }, [run.id]);
  // Poll while the button might be relevant, so a PR merged or closed while
  // the run is on screen loses its button within half a minute.
  useEffect(() => {
    if (!followUpReady) return;
    let cancelled = false;
    const probe = () => {
      api
        .prStatus(run.id)
        .then((status: PrStatusResponse) => {
          if (!cancelled) setPrState(status.state);
        })
        .catch(() => {
          // keep the last known state; the interval retries
        });
    };
    probe();
    const interval = setInterval(probe, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [run.id, followUpReady, probeTick]);
  // The button renders only once GitHub confirms the PR is open (a draft
  // counts: it still takes feedback and pushes); the server still enforces
  // the real gating (409 when the PR turns out merged/closed).
  const showFollowUp =
    (followUpReady && (prState === "open" || prState === "draft")) || followUpInFlight;
  // Covers the gap between the click's POST and the active run snapshot
  // arriving, so the slow GitHub preflight still shows a spinner.
  const followUpPending = busy || followUpInFlight;
  const [tab, setTab] = useState<LeftTab>(hasOutcome ? "result" : "console");
  const [terminalStarted, setTerminalStarted] = useState(false);
  // Selecting a different run resets the view, and the outcome drives it while
  // a run stays open: the Result tab appears and takes focus the moment the
  // run finishes, and hands back to the console when a retry clears the
  // outcome (the strip is Console-only again then, so no other tab is valid).
  useEffect(() => {
    setTab(hasOutcome ? "result" : "console");
    setTerminalStarted(false);
  }, [run.id, hasOutcome]);
  const artifacts = run.result?.artifacts ?? collectArtifacts(events);
  const hasResult = Boolean(run.result);
  const hasArtifacts = artifacts.length > 0;
  const shipped = run.status === "completed";
  // Older persisted runs may carry costTotals without a byModel breakdown;
  // fall back to recomputing from the raw entries, mirroring CostBadge.
  const computedCosts = run.costs.length > 0 ? summarizeCosts(run.costs) : undefined;
  const costTotals = run.costTotals ?? computedCosts;
  const costByModel = run.costTotals?.byModel ?? computedCosts?.byModel ?? [];
  // The worker that holds this run's sandbox. Offline workers stay in the
  // fleet, so this only misses once one has been revoked; then the raw id is
  // all an old run has left to name it by.
  const worker = run.sandbox.workerId
    ? workers.find((w) => w.id === run.sandbox.workerId)
    : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-ink-700/70 bg-ink-900/90 px-4 py-2">
        <a
          href={run.ticket.url}
          target="_blank"
          rel="noreferrer"
          className="group touch-target inline-flex items-center gap-1.5 font-plate text-[11px] tracking-[0.06em] text-haze-200 hover:text-haze-50"
        >
          {run.ticket.identifier}
          <External className="size-3 text-haze-700 transition-colors group-hover:text-haze-300" />
        </a>

        <StatusChip status={run.status} />

        <span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-2.5 gap-y-2">
          <CostBadge costs={run.costs} totals={run.costTotals} align="end" className="text-[11px]" />
          <RepoChip repo={repoName} />
          <Badge variant="secondary">
            <span className="text-haze-700">State</span>
            <span className="font-mono text-[11px] leading-none tracking-normal normal-case text-haze-300">
              {run.ticket.state}
            </span>
          </Badge>
          {prChipUrl && prChipState && <PrChip url={prChipUrl} state={prChipState} />}
          {(live || retryable || showFollowUp) && (
            <span aria-hidden className="h-4 w-px shrink-0 bg-ink-700" />
          )}
          {/* Coexists with Cancel while a follow-up is running (live): the user
              can watch the spinner state or cancel it like any other attempt. */}
          {showFollowUp && (
            <Button
              variant="outline"
              size="plate"
              onClick={() => {
                void Promise.resolve(onFollowUp()).finally(() => setProbeTick((t) => t + 1));
              }}
              disabled={followUpPending}
              title="Rebase the PR onto its base branch and address review feedback"
            >
              <Refresh className={`size-3 ${followUpPending ? "animate-spin" : ""}`} />
              {followUpPending ? "Taking another look" : "Take another look"}
            </Button>
          )}
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

      <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
        <div className="shrink-0">
          <h2 className="text-[17px] leading-snug font-medium text-haze-50">
            {run.ticket.title}
          </h2>
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

          {run.status === "queued" && run.queueReason && <QueuedBanner reason={run.queueReason} />}

          {/* Two explicit rows: the tab strip alone on top, then the active
              panel and the evidence card side by side in one stretched row,
              so both cards share a top edge and a bottom edge. */}
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-x-4 gap-y-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] xl:grid-rows-[auto_minmax(0,1fr)]">
              <div className="no-scrollbar flex items-end gap-1 self-end overflow-x-auto border-b border-ink-700/70 xl:col-start-1 xl:row-start-1" role="tablist">
                {hasOutcome && (
                  <TabButton active={tab === "result"} onClick={() => setTab("result")}>
                    Result
                  </TabButton>
                )}
                <TabButton active={tab === "console"} onClick={() => setTab("console")}>
                  Console
                </TabButton>
                {finished && (
                  <TabButton
                    active={tab === "terminal"}
                    disabled={!resumable}
                    title={
                      resumable
                        ? "Resume the agent conversation in this run's sandbox"
                        : !sandboxRetained
                          ? "The run's sandbox is no longer available; it was cleaned up when the retention window ended."
                          : "No agent session was captured for this run; resume supports Claude runs only."
                    }
                    onClick={() => {
                      setTerminalStarted(true);
                      setTab("terminal");
                    }}
                  >
                    Terminal
                  </TabButton>
                )}
              </div>

              {/* Inactive panels hide instead of unmounting: the console keeps
                  its scroll position and the terminal keeps its live session. */}
              <div className="h-[max(320px,calc(100svh-21rem))] min-h-0 min-w-0 xl:h-auto xl:col-start-1 xl:row-start-2">
                <div className={tab === "result" ? "h-full" : "hidden"}>
                  <Card className="flex h-full min-h-[320px] flex-col gap-0 overflow-hidden py-0">
                    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-ink-700 bg-ink-800/60 px-3">
                      <Plate className="text-haze-400">Result</Plate>
                      {hasResult && shipped && <span className="plate text-mint-400">Shipped</span>}
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto p-4">
                      {run.error && (
                        <Alert
                          variant="destructive"
                          className="mb-4 rounded-[5px] border-rust-500/35 bg-rust-500/8 p-3"
                        >
                          <AlertTitle className="plate text-rust-400">Error</AlertTitle>
                          <AlertDescription className="mt-1 min-w-0 font-mono text-[11.5px] leading-relaxed text-wrap break-words whitespace-pre-wrap text-rust-400/90 md:text-wrap">
                            {run.error}
                          </AlertDescription>
                        </Alert>
                      )}
                      <ResultCard run={run} />
                      {!hasResult && !run.error && (
                        <p className="text-[12.5px] leading-relaxed text-haze-600">
                          The run ended without producing a result.
                        </p>
                      )}
                    </div>
                  </Card>
                </div>
                <div className={tab === "console" ? "h-full" : "hidden"}>
                  <Console runId={run.id} events={events} live={live} fill />
                </div>
                {terminalStarted && resumable && (
                  <div className={tab === "terminal" ? "h-full" : "hidden"}>
                    <AttachTerminal
                      runId={run.id}
                      retainedUntil={run.sandbox.retainedUntil as string}
                      now={now}
                      onClose={() => {
                        setTerminalStarted(false);
                        setTab("console");
                      }}
                    />
                  </div>
                )}
              </div>

            <aside className="flex min-h-0 min-w-0 flex-col gap-3 xl:col-start-2 xl:row-start-2">
              {/* The key figures the phase spine used to carry. */}
              <Card className="block shrink-0 px-4 py-3.5">
                <div className="grid grid-cols-2 gap-x-5 gap-y-3">
                  <Field label="Elapsed">
                    {run.finishedAt && run.startedAt
                      ? duration(run.startedAt, Date.parse(run.finishedAt))
                      : duration(run.startedAt ?? run.createdAt, now)}
                  </Field>
                  {run.attempts.length > 1 && (
                    <Field label="Attempts">{run.attempts.length}</Field>
                  )}
                  {run.sandbox.provider && <Field label="Sandbox">{run.sandbox.provider}</Field>}
                  {run.sandbox.workerId && (
                    <Field label="Worker">{worker ? worker.name : run.sandbox.workerId}</Field>
                  )}
                  {run.sandbox.id && <Field label="VM">{run.sandbox.id}</Field>}
                  <Field label="Run">{run.id}</Field>
                </div>
              </Card>

              {costTotals && (
                <Card className="block shrink-0 px-4 py-3.5">
                  <span className="plate text-haze-700">Cost</span>
                  <div className="mt-2">
                    <CostBreakdown byModel={costByModel} totals={costTotals} variant="panel" />
                  </div>
                </Card>
              )}

              <Card className="flex min-h-[280px] flex-1 flex-col gap-0 overflow-hidden py-0">
                <div className="flex h-10 shrink-0 items-center gap-2 border-b border-ink-700 bg-ink-800/60 px-3">
                  <Plate className="text-haze-400">Evidence</Plate>
                  {hasArtifacts && (
                    <span className="font-mono text-[11px] leading-none text-haze-700">
                      {artifacts.length}
                    </span>
                  )}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                  <Artifacts runId={run.id} artifacts={artifacts} />
                  {!hasArtifacts && (
                    <p className="text-[12.5px] leading-relaxed text-haze-600">
                      Screenshots and recordings appear here as the run captures them.
                    </p>
                  )}
                </div>
              </Card>
            </aside>
          </div>
      </div>
    </div>
  );
}

type LeftTab = "result" | "console" | "terminal";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <span className="plate text-haze-700">{label}</span>
      <p className="mt-1 truncate font-mono text-[11px] text-haze-300" title={String(children)}>
        {children}
      </p>
    </div>
  );
}

function TabButton({
  active,
  disabled,
  title,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={`-mb-px shrink-0 touch-target border-b-2 px-3 py-2 font-plate text-[11px] tracking-[0.06em] whitespace-nowrap transition-colors ${
        active
          ? "border-ember-500 text-haze-50"
          : disabled
            ? "cursor-not-allowed border-transparent text-haze-800"
            : "cursor-pointer border-transparent text-haze-600 hover:text-haze-200"
      }`}
    >
      {children}
    </button>
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

/**
 * The run is queued but nothing can dispatch it yet; say why. Neutral haze
 * tones, matching the queued status's own colour (STATUS_TONE.queued):
 * waiting on capacity is not "connected" (mint) or "working" (ember).
 */
function QueuedBanner({ reason }: { reason: string }) {
  return (
    <div className="rounded-[5px] border border-haze-700/50 bg-haze-600/10 p-3">
      <p className="text-[12.5px] leading-relaxed text-haze-400">{reason}</p>
    </div>
  );
}

function limitLabel(limit: LimitInfo): string {
  const provider =
    limit.provider === "claude" ? "Claude" : limit.provider === "grok" ? "Grok" : "Codex";
  const kind = limit.kind === "unknown" ? "usage limit" : `${limit.kind} limit`;
  return `${provider} ${kind} reached`;
}

/** Before a run finishes there is no result, but artifact events still arrive. */
function collectArtifacts(events: RunEvent[]) {
  const seen = new Map<string, RunEvent & { type: "artifact" }>();
  for (const e of events) if (e.type === "artifact") seen.set(e.artifact.name, e);
  return [...seen.values()].map((e) => e.artifact);
}
