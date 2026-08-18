import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { BreviConfig, PrState, PullSummary } from "@brevi/shared";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "../lib/api";
import { relative } from "../lib/format";
import { ChevronRight, Merge, Pull, Refresh, Warn } from "./Icons";

/** Refresh cadence while the list is on screen. */
const LIST_POLL_MS = 60_000;

type Filter = "open" | "merged" | "closed" | "all";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "merged", label: "Merged" },
  { id: "closed", label: "Closed" },
  { id: "all", label: "All" },
];

/** Which list states a filter admits; drafts belong with open. */
function matches(filter: Filter, state: PrState): boolean {
  if (filter === "all") return true;
  if (filter === "open") return state === "open" || state === "draft";
  return state === filter;
}

const STATE_FG: Record<PrState, string> = {
  open: "text-pr-open",
  draft: "text-pr-draft",
  merged: "text-pr-merged",
  closed: "text-pr-closed",
};

/** The state's icon in the state's colour, GitHub-style. */
export function PullStateIcon({ state, className = "size-4" }: { state: PrState; className?: string }) {
  const Icon = state === "merged" ? Merge : Pull;
  return <Icon className={`${className} ${STATE_FG[state]}`} />;
}

/**
 * The Pull Requests page: every configured repository's PRs in one list,
 * filterable by state and repo, so working a PR never needs GitHub's own UI.
 */
export function PullRequestsPage({
  config,
  onOpenPull,
  onOpenConfig,
}: {
  config: BreviConfig | null;
  onOpenPull: (repoKey: string, number: number) => void;
  /** Opens the Connectors config page, for the not-connected empty state. */
  onOpenConfig: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("open");
  const [repoFilter, setRepoFilter] = useState<string>("");

  // The query keeps the last good list through a transient failure; the
  // banner says why the refresh failed while the stale rows stay readable.
  const {
    data: response,
    error: queryError,
    isFetching: refreshing,
    refetch,
  } = useQuery({
    queryKey: ["pulls"],
    queryFn: api.pulls,
    refetchInterval: LIST_POLL_MS,
  });
  const error = queryError === null ? null : queryError.message;

  const notConnected = error !== null && /GitHub is not connected/i.test(error);
  const pulls = (response?.pulls ?? []).filter(
    (pull) => matches(filter, pull.state) && (repoFilter === "" || pull.repo === repoFilter),
  );
  const repoKeys = Object.keys(config?.repos ?? {}).sort();
  const counts = new Map<Filter, number>(
    FILTERS.map(({ id }) => [
      id,
      (response?.pulls ?? []).filter(
        (pull) => matches(id, pull.state) && (repoFilter === "" || pull.repo === repoFilter),
      ).length,
    ]),
  );
  const now = Date.now();

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-5 sm:py-7 md:px-8">
      <header className="flex items-center gap-2.5">
        <h2 className="text-[16px] font-semibold text-haze-50">Pull requests</h2>
        <span className="ml-auto flex items-center gap-2">
          {repoKeys.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    aria-label="Filter by repository"
                    className="touch-target flex cursor-pointer items-center gap-1.5 rounded-md text-[12px] font-medium text-haze-400 hover:text-haze-100"
                  />
                }
              >
                {repoFilter === "" ? "All repositories" : repoDisplayName(config, repoFilter)}
                <ChevronRight className="size-3 rotate-90 text-haze-600" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-44">
                <DropdownMenuRadioGroup value={repoFilter} onValueChange={setRepoFilter}>
                  <DropdownMenuRadioItem value="">All repositories</DropdownMenuRadioItem>
                  {repoKeys.map((key) => (
                    <DropdownMenuRadioItem key={key} value={key}>
                      {repoDisplayName(config, key)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh pull requests"
            title="Refresh from GitHub"
            onClick={() => void refetch()}
            disabled={refreshing}
            className="text-haze-600 hover:text-haze-200"
          >
            <Refresh className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
          </Button>
        </span>
      </header>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-haze-400">
        Every configured repository&apos;s pull requests: read the diff, answer reviews, watch
        checks, and merge, all without leaving Mission Control.
      </p>

      <nav
        aria-label="Pull request states"
        className="no-scrollbar mt-4 flex items-center gap-4 overflow-x-auto border-b border-ink-700"
      >
        {FILTERS.map(({ id, label }) => {
          const active = filter === id;
          return (
            <button
              key={id}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => setFilter(id)}
              className={`touch-target -mb-px flex shrink-0 cursor-pointer items-center gap-1.5 border-b pb-2 text-[12px] font-medium whitespace-nowrap ${
                active
                  ? "border-haze-50 text-haze-50"
                  : "border-transparent text-haze-600 hover:text-haze-300"
              }`}
            >
              {label}
              {response !== undefined && (
                <span className="font-mono text-[10.5px] leading-none text-haze-600">
                  {counts.get(id) ?? 0}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {error !== null && !notConnected && (
        <Alert
          variant="destructive"
          className="mt-4 items-center rounded-lg border-rust-500/30 bg-rust-500/10 px-3 py-2"
        >
          <Warn className="size-3.5 text-rust-400" />
          <AlertDescription className="text-[12.5px] text-rust-400">
            Could not refresh pull requests. {error}
          </AlertDescription>
        </Alert>
      )}

      {response?.errors.map((repoError) => (
        <Alert
          key={repoError.repo}
          variant="destructive"
          className="mt-4 items-center rounded-lg border-rust-500/30 bg-rust-500/10 px-3 py-2"
        >
          <Warn className="size-3.5 text-rust-400" />
          <AlertDescription className="text-[12.5px] text-rust-400">
            {repoError.remote}: {repoError.message}
          </AlertDescription>
        </Alert>
      ))}

      <div className="mt-4">
        {notConnected ? (
          <EmptyNote>
            GitHub isn&apos;t connected, so there are no pull requests to show.{" "}
            <Button
              type="button"
              variant="link"
              className="h-auto p-0 align-baseline text-[12.5px] text-haze-200 hover:text-haze-50"
              onClick={onOpenConfig}
            >
              Connect GitHub
            </Button>{" "}
            to fill this page.
          </EmptyNote>
        ) : response === undefined && error === null ? (
          <EmptyNote>Loading pull requests from GitHub…</EmptyNote>
        ) : pulls.length === 0 ? (
          <EmptyNote>
            {filter === "open"
              ? "No open pull requests. Finished runs open theirs here as they ship."
              : `No ${filter === "all" ? "" : `${filter} `}pull requests${repoFilter ? " in this repository" : ""}.`}
          </EmptyNote>
        ) : (
          <ul className="flex flex-col overflow-hidden rounded-lg ring-1 ring-foreground/10">
            {pulls.map((pull) => (
              <li key={`${pull.repo}#${pull.number}`} className="border-b border-ink-700/60 last:border-b-0">
                <PullRow pull={pull} now={now} onOpen={() => onOpenPull(pull.repo, pull.number)} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function repoDisplayName(config: BreviConfig | null, key: string): string {
  return config?.repos[key]?.remote ?? key;
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="px-1 py-6 text-[12.5px] leading-relaxed text-haze-600">{children}</p>;
}

/**
 * One pull request row: state icon, title, and the who/where/when line,
 * GitHub's list distilled. The whole row is a real link so middle-click and
 * copy-link behave.
 */
function PullRow({ pull, now, onOpen }: { pull: PullSummary; now: number; onOpen: () => void }) {
  return (
    <a
      href={`/pulls/${encodeURIComponent(pull.repo)}/${pull.number}`}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        onOpen();
      }}
      className="flex cursor-pointer items-start gap-2.5 bg-card px-3 py-2.5 transition-colors hover:bg-ink-800"
    >
      <PullStateIcon state={pull.state} className="mt-[1px] size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-haze-100" title={pull.title}>
          {pull.title}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[10.5px] leading-relaxed text-haze-600">
          {pull.remote}#{pull.number}
          <span className="text-haze-700"> · </span>
          {pull.author}
          <span className="text-haze-700"> · </span>
          {pull.headBranch}
          <span className="text-haze-700"> → </span>
          {pull.baseBranch}
        </span>
      </span>
      <span
        className="mt-[2px] shrink-0 font-mono text-[10.5px] leading-none tabular-nums text-haze-600"
        title={pull.state === "merged" ? "Merged" : "Last activity"}
      >
        {relative(pull.mergedAt ?? pull.updatedAt, now)}
      </span>
    </a>
  );
}
