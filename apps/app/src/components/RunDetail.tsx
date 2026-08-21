import type {
  HealthResponse,
  HostExecution,
  LimitInfo,
  PrState,
  PrStatusResponse,
  Run,
  RunEvent,
  WorkerView,
} from "@brevi/shared";
import { summarizeCosts } from "@brevi/shared/types";
import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useSidebar } from "@/components/ui/sidebar";
import { api } from "../lib/api";
import { clock, elapsed } from "../lib/format";
import { queueOnly } from "../lib/fleet";
import { isActive, isTerminal } from "../lib/status";
import { Activity, type ActivityComposer } from "./Activity";
import { Artifacts } from "./Artifacts";
import { Plate, PrChip, RepoChip, StatusChip } from "./Bits";
import { CostBadge, CostBreakdown } from "./CostBadge";
import { Archive, External, Play, Refresh, Stop, Unarchive } from "./Icons";

export function RunDetail({
  run,
  repoName,
  workers,
  health,
  events,
  now,
  busy,
  onCancel,
  onRetry,
  onArchive,
  onFollowUp,
  onOpenPull,
  onOpenWorkers,
}: {
  run: Run;
  /** owner/name of the mapped repo, resolved from config. */
  repoName: string | undefined;
  /** The enrolled fleet, for the queued banner's capacity check. */
  workers: WorkerView[];
  /** Whether this machine can execute runs itself, for the queued banner. */
  health: HealthResponse | null;
  events: RunEvent[];
  now: number;
  busy: boolean;
  onCancel: () => void;
  onRetry: () => void;
  /** Archives the run, or restores it when the run is already archived. */
  onArchive: () => void;
  /** Queue a follow-up run, with the composer's instructions when given; resolves to the queued run or undefined on failure. */
  onFollowUp: (instructions?: string) => Promise<Run | undefined>;
  /** Opens brevi's own pull request page for the run's PR. */
  onOpenPull: (repoKey: string, number: number) => void;
  /** Opens the Workers config page, for the queued banner's fix. */
  onOpenWorkers: () => void;
}) {
  const live = isActive(run.status);
  // Set only when this machine cannot execute and nothing else is connected,
  // so the queued banner can add its fix on top of the scheduler's own reason.
  const queueOnlyExecution =
    health?.hostExecution?.kind === "none" && queueOnly(health, workers)
      ? health.hostExecution
      : undefined;
  const retryable = run.status === "failed" || run.status === "cancelled";
  // The header chip renders from the run-level PR metadata streamed by the
  // orchestrator's background poll; the follow-up button below keeps its own
  // fresher 30s probe.
  const prChipUrl = run.prUrl;
  const prChipState = prChipUrl ? (run.prState ?? "open") : undefined;
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
  // The composer under the activity feed shares the follow-up gating: it can
  // send exactly when "Take another look" can, and otherwise says why not.
  const composerEnabled = followUpReady && (prState === "open" || prState === "draft") && !followUpPending;
  const composerHint = live
    ? followUpInFlight
      ? "A follow-up is running; more instructions can be sent when it finishes."
      : "The run is still working; instructions can be sent when it finishes."
    : !followUpReady
      ? "Only finished runs that delivered a pull request can take follow-up instructions."
      : prState === "merged" || prState === "closed"
        ? `The pull request is ${prState}; nothing left to follow up on.`
        : prState === "unknown"
          ? "Checking the pull request…"
          : undefined;
  const composer: ActivityComposer = {
    enabled: composerEnabled,
    hint: composerHint,
    busy: followUpPending,
    onSend: async (text) => {
      const queued = await onFollowUp(text);
      setProbeTick((t) => t + 1);
      return queued !== undefined;
    },
  };
  const repoKey = run.ticket.repo;
  /** Internal open handler for a PR url, when its number and repo mapping resolve. */
  const openPr = (url: string): (() => void) | undefined => {
    const number = prNumberOf(url);
    return repoKey && number !== undefined ? () => onOpenPull(repoKey, number) : undefined;
  };
  const artifacts = run.result?.artifacts ?? collectArtifacts(events);
  const hasArtifacts = artifacts.length > 0;
  // Older persisted runs may carry costTotals without a byModel breakdown;
  // fall back to recomputing from the raw entries, mirroring CostBadge.
  const computedCosts = run.costs.length > 0 ? summarizeCosts(run.costs) : undefined;
  const costTotals = run.costTotals ?? computedCosts;
  const costByModel = run.costTotals?.byModel ?? computedCosts?.byModel ?? [];
  // While the sidebar is collapsed the static trigger overlays this corner;
  // shift the header content clear of it (see .collapsed-trigger-offset).
  const { open, openMobile, isMobile } = useSidebar();
  const sidebarClosed = isMobile ? !openMobile : !open;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className={`flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 bg-background px-4 py-2 ${
          sidebarClosed ? "collapsed-trigger-offset" : ""
        }`}
      >
        <span
          className="min-w-0 max-w-full flex-1 basis-52 truncate text-[13.5px] font-semibold text-haze-50"
          title={run.ticket.title}
        >
          {run.ticket.title}
        </span>

        <a
          href={run.ticket.url}
          target="_blank"
          rel="noreferrer"
          className="group touch-target inline-flex items-center gap-1.5 font-mono text-[11.5px] font-medium text-haze-400 hover:text-haze-50"
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
          {prChipUrl && prChipState && (
            <PrChip url={prChipUrl} state={prChipState} onOpen={openPr(prChipUrl)} />
          )}
          {(live || retryable || showFollowUp || isTerminal(run.status)) && (
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
          {isTerminal(run.status) && (
            <Button
              variant="outline"
              size="plate"
              onClick={onArchive}
              disabled={busy}
              title={
                run.archivedAt
                  ? "Bring the run back into the sidebar list"
                  : "Hide the run from the sidebar list; it stays under Archived"
              }
            >
              {run.archivedAt ? <Unarchive className="size-3" /> : <Archive className="size-3" />}
              {run.archivedAt ? "Unarchive" : "Archive"}
            </Button>
          )}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
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

          {run.status === "queued" && run.queueReason && (
            <QueuedBanner
              reason={run.queueReason}
              hostExecution={queueOnlyExecution}
              onOpenWorkers={onOpenWorkers}
            />
          )}

          {/* What stopped the run; the header's PR chip covers the happy path. */}
          {run.error && (
            <Alert
              variant="destructive"
              className="shrink-0 rounded-lg border-rust-500/35 bg-rust-500/8 p-3"
            >
              <AlertTitle className="plate text-rust-400">Error</AlertTitle>
              <AlertDescription className="mt-1 min-w-0 font-mono text-[11.5px] leading-relaxed text-wrap break-words whitespace-pre-wrap text-rust-400/90 md:text-wrap">
                {run.error}
              </AlertDescription>
            </Alert>
          )}

          {/* The activity feed and the evidence column side by side in one
              stretched row, so both cards share a top edge and a bottom edge. */}
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-x-4 gap-y-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
              <div className="h-[max(320px,calc(100svh-19rem))] min-h-0 min-w-0 xl:h-auto">
                <Activity runId={run.id} events={events} live={live} composer={composer} />
              </div>

            <aside className="flex min-h-0 min-w-0 flex-col gap-3">
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

/** PR number from its GitHub URL, for opening brevi's own pull request page. */
function prNumberOf(url: string): number | undefined {
  const match = /\/pull\/(\d+)(?:[/?#]|$)/.exec(url);
  return match ? Number(match[1]) : undefined;
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
    <div className="rounded-lg border border-iris-400/35 bg-iris-400/8 p-3">
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
function QueuedBanner({
  reason,
  hostExecution,
  onOpenWorkers,
}: {
  reason: string;
  /** Set only when this machine cannot execute and nothing else is connected. */
  hostExecution: Extract<HostExecution, { kind: "none" }> | undefined;
  onOpenWorkers: () => void;
}) {
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-850 p-3">
      <p className="text-[12.5px] leading-relaxed text-haze-400">{reason}</p>
      {hostExecution && (
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-haze-400">
          This machine can&apos;t run agents itself.{" "}
          Set up a worker machine over SSH from the{" "}
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 align-baseline text-[12.5px] text-haze-200 hover:text-haze-50"
            onClick={onOpenWorkers}
          >
            Fleet page
          </Button>
          .
        </p>
      )}
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
