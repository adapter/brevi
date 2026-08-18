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
import { PullRequestDetailPage } from "./PullRequestDetail";
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

/** One selected pull request, parsed out of the "pull:<repoKey>/<number>" page. */
export interface PullSelection {
  repoKey: string;
  number: number;
}

/**
 * The Pull Requests page as a full-width split view: the list pane on the
 * left, the selected PR's detail filling the rest. Below lg the panes take
 * turns instead (the detail carries a back link), since both cannot fit.
 */
export function PullsPage({
  config,
  selected,
  onOpenPull,
  onOpenPulls,
  onOpenConfig,
}: {
  config: BreviConfig | null;
  selected: PullSelection | null;
  onOpenPull: (repoKey: string, number: number) => void;
  /** Clears the selection; the detail pane's back link on small screens. */
  onOpenPulls: () => void;
  /** Opens the Connectors config page, for the not-connected empty state. */
  onOpenConfig: () => void;
}) {
  return (
    <div className="flex h-full min-h-0">
      <div
        className={`${
          selected ? "hidden lg:flex" : "flex"
        } h-full min-h-0 w-full flex-col border-ink-700 lg:w-80 lg:shrink-0 lg:border-r xl:w-88`}
      >
        <PullListPane
          config={config}
          selected={selected}
          onOpenPull={onOpenPull}
          onOpenConfig={onOpenConfig}
        />
      </div>
      <div className={`${selected ? "block" : "hidden lg:block"} h-full min-h-0 flex-1 overflow-y-auto`}>
        {selected ? (
          <PullRequestDetailPage
            key={`${selected.repoKey}/${selected.number}`}
            repoKey={selected.repoKey}
            number={selected.number}
            onBack={onOpenPulls}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-8">
            <div className="text-center">
              <Pull className="mx-auto size-6 text-haze-700" />
              <p className="mt-3 text-[13px] font-medium text-haze-400">Select a pull request</p>
              <p className="mt-1 text-[12px] leading-relaxed text-haze-600">
                Its conversation, diff, checks, and merge controls open here.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PullListPane({
  config,
  selected,
  onOpenPull,
  onOpenConfig,
}: {
  config: BreviConfig | null;
  selected: PullSelection | null;
  onOpenPull: (repoKey: string, number: number) => void;
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
    <>
      <header className="flex shrink-0 items-center gap-2 px-3 pt-4">
        <h2 className="text-[14px] leading-none font-semibold text-haze-50">Pull requests</h2>
        <span className="ml-auto flex items-center gap-1">
          {repoKeys.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    aria-label="Filter by repository"
                    title={repoFilter === "" ? "All repositories" : repoDisplayName(config, repoFilter)}
                    className="touch-target flex max-w-40 cursor-pointer items-center gap-1 rounded-md text-[11.5px] font-medium text-haze-500 hover:text-haze-100"
                  />
                }
              >
                <span className="min-w-0 truncate">
                  {repoFilter === "" ? "All repos" : repoDisplayName(config, repoFilter)}
                </span>
                <ChevronRight className="size-3 shrink-0 rotate-90 text-haze-600" />
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

      <nav
        aria-label="Pull request states"
        className="no-scrollbar mx-3 mt-2.5 flex shrink-0 items-center gap-3.5 overflow-x-auto border-b border-ink-700"
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

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {error !== null && !notConnected && (
          <Alert
            variant="destructive"
            className="mb-2 items-center rounded-lg border-rust-500/30 bg-rust-500/10 px-2.5 py-1.5"
          >
            <Warn className="size-3.5 text-rust-400" />
            <AlertDescription className="text-[11.5px] text-rust-400">
              Could not refresh. {error}
            </AlertDescription>
          </Alert>
        )}
        {response?.errors.map((repoError) => (
          <Alert
            key={repoError.repo}
            variant="destructive"
            className="mb-2 items-center rounded-lg border-rust-500/30 bg-rust-500/10 px-2.5 py-1.5"
          >
            <Warn className="size-3.5 text-rust-400" />
            <AlertDescription className="text-[11.5px] text-rust-400">
              {repoError.remote}: {repoError.message}
            </AlertDescription>
          </Alert>
        ))}

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
          <ul className="flex flex-col gap-1">
            {pulls.map((pull) => (
              <li key={`${pull.repo}#${pull.number}`}>
                <PullRow
                  pull={pull}
                  now={now}
                  selected={selected?.repoKey === pull.repo && selected.number === pull.number}
                  onOpen={() => onOpenPull(pull.repo, pull.number)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function repoDisplayName(config: BreviConfig | null, key: string): string {
  return config?.repos[key]?.remote ?? key;
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="px-1.5 py-4 text-[12.5px] leading-relaxed text-haze-600">{children}</p>;
}

/**
 * One pull request row, compact for the pane: the state and where/when line,
 * then the title clamped to two lines. A real link, so middle-click and
 * copy-link behave.
 */
function PullRow({
  pull,
  now,
  selected,
  onOpen,
}: {
  pull: PullSummary;
  now: number;
  selected: boolean;
  onOpen: () => void;
}) {
  return (
    <a
      href={`/pulls/${encodeURIComponent(pull.repo)}/${pull.number}`}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        onOpen();
      }}
      aria-current={selected ? "page" : undefined}
      title={`${pull.remote}#${pull.number}: ${pull.title}`}
      className={`block rounded-lg px-2.5 py-1.5 ring-1 transition-colors ${
        selected ? "bg-ink-750 ring-ink-500" : "bg-card ring-foreground/10 hover:bg-ink-800"
      }`}
    >
      <span className="flex h-5 items-center gap-1.5">
        <PullStateIcon state={pull.state} className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate font-mono text-[10.5px] leading-none text-haze-400">
          {pull.remote.split("/")[1] ?? pull.remote}#{pull.number}
        </span>
        <span
          className="ml-auto shrink-0 font-mono text-[10px] leading-none tabular-nums text-haze-600"
          title={pull.state === "merged" ? "Merged" : "Last activity"}
        >
          {relative(pull.mergedAt ?? pull.updatedAt, now)}
        </span>
      </span>
      <span
        className={`mt-0.5 line-clamp-2 text-[12px] leading-[16px] ${
          selected ? "text-haze-50" : "text-haze-200"
        }`}
      >
        {pull.title}
      </span>
      <span className="mt-0.5 block truncate font-mono text-[10px] leading-relaxed text-haze-600">
        {pull.author}
        <span className="text-haze-700"> · </span>
        {pull.headBranch}
      </span>
    </a>
  );
}
