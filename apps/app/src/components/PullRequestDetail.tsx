import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  PullComment,
  PullDetailResponse,
  PullFile,
  PullMergeMethod,
  PullReview,
  PullThread,
} from "@brevi/shared";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "../lib/api";
import { parseUnifiedDiff, type DiffLine } from "../lib/activity";
import { relative } from "../lib/format";
import { Plate, PrChip } from "./Bits";
import { DiffTable } from "./Diff";
import { Markdown } from "./Markdown";
import {
  ArrowLeft,
  Branch,
  Check,
  ChevronRight,
  Close,
  Doc,
  External,
  Merge,
  Refresh,
  Warn,
} from "./Icons";

/** Refresh cadence while a PR is on screen; every action refreshes on its own. */
const DETAIL_POLL_MS = 60_000;

type Tab = "conversation" | "files" | "commits" | "checks";

/**
 * One pull request, whole: description, conversation (comments, reviews,
 * review threads with replies and resolution), files as real diffs, commits,
 * checks, and the merge itself. GitHub's PR page, drawn the house way.
 */
export function PullRequestDetailPage({
  repoKey,
  number,
  onBack,
}: {
  repoKey: string;
  number: number;
  /** Returns to the Pull Requests list. */
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<PullDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** A failed action's message; load failures use `error` instead. */
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /** Key of the action in flight, so exactly one spinner shows. */
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("conversation");
  const [mergeMethod, setMergeMethod] = useState<PullMergeMethod>("squash");

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      setDetail(await api.pullDetail(repoKey, number));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The orchestrator did not respond.");
    } finally {
      setRefreshing(false);
    }
  }, [repoKey, number]);

  useEffect(() => {
    setDetail(null);
    setError(null);
    setNotice(null);
    setTab("conversation");
    void load();
    const id = setInterval(() => void load(), DETAIL_POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  /** Run one write action, then re-fetch so the view shows GitHub's truth. */
  const act = useCallback(
    async (key: string, action: () => Promise<unknown>) => {
      setBusy(key);
      setNotice(null);
      try {
        await action();
        await load();
        return true;
      } catch (err) {
        setNotice(err instanceof Error ? err.message : "The orchestrator did not respond.");
        return false;
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const timeline = useMemo(() => (detail ? buildTimeline(detail) : []), [detail]);
  const now = Date.now();

  if (detail === null) {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-5 sm:py-7 md:px-8">
        <BackLink onBack={onBack} />
        {error !== null ? (
          <Alert
            variant="destructive"
            className="mt-4 items-center rounded-lg border-rust-500/30 bg-rust-500/10 px-3 py-2"
          >
            <Warn className="size-3.5 text-rust-400" />
            <AlertDescription className="text-[12.5px] text-rust-400">
              Could not load the pull request. {error}
            </AlertDescription>
          </Alert>
        ) : (
          <p className="mt-4 text-[12.5px] leading-relaxed text-haze-600">
            Loading the pull request from GitHub…
          </p>
        )}
      </div>
    );
  }

  const { pull } = detail;
  const open = pull.state === "open" || pull.state === "draft";
  const unresolved = detail.threads.filter((thread) => !thread.resolved).length;
  const failingChecks = detail.checks.filter((check) => isFailure(check.status)).length;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-5 sm:py-7 md:px-8">
      <BackLink onBack={onBack} />

      <header className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="min-w-0 flex-1 basis-64 text-[16px] leading-snug font-semibold text-haze-50">
          {pull.title}{" "}
          <a
            href={pull.url}
            target="_blank"
            rel="noreferrer"
            title="Open on GitHub"
            className="group inline-flex items-center gap-1 align-baseline font-mono text-[13px] font-medium text-haze-500 hover:text-haze-100"
          >
            #{pull.number}
            <External className="size-3 text-haze-700 transition-colors group-hover:text-haze-300" />
          </a>
        </h2>
        <span className="flex items-center gap-2">
          <PrChip url={pull.url} state={pull.state} />
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh pull request"
            title="Refresh from GitHub"
            onClick={() => void load()}
            disabled={refreshing}
            className="text-haze-600 hover:text-haze-200"
          >
            <Refresh className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
          </Button>
        </span>
      </header>

      <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-haze-500">
        <span className="font-mono text-[11px]">{pull.remote}</span>
        <span className="text-haze-700">·</span>
        <span>
          {pull.author} wants to merge{" "}
          <code className="rounded-[3px] bg-ink-800 px-1 py-0.5 font-mono text-[10.5px] text-haze-300">
            {pull.headBranch}
          </code>{" "}
          into{" "}
          <code className="rounded-[3px] bg-ink-800 px-1 py-0.5 font-mono text-[10.5px] text-haze-300">
            {pull.baseBranch}
          </code>
        </span>
        <span className="text-haze-700">·</span>
        <span title={pull.state === "merged" ? "Merged" : "Last activity"}>
          {pull.state === "merged" ? "merged" : "updated"} {relative(pull.mergedAt ?? pull.updatedAt, now)}
        </span>
      </p>

      {error !== null && (
        <Alert
          variant="destructive"
          className="mt-4 items-center rounded-lg border-rust-500/30 bg-rust-500/10 px-3 py-2"
        >
          <Warn className="size-3.5 text-rust-400" />
          <AlertDescription className="text-[12.5px] text-rust-400">
            Showing the last loaded state; the refresh failed. {error}
          </AlertDescription>
        </Alert>
      )}
      {notice !== null && (
        <Alert
          variant="destructive"
          className="mt-4 items-center rounded-lg border-rust-500/30 bg-rust-500/10 px-3 py-2"
        >
          <Warn className="size-3.5 text-rust-400" />
          <AlertDescription className="text-[12.5px] text-rust-400">{notice}</AlertDescription>
        </Alert>
      )}

      <div className="mt-5 grid grid-cols-1 gap-x-4 gap-y-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
        <div className="min-w-0">
          <div className="no-scrollbar flex items-end gap-1 overflow-x-auto border-b border-ink-700/70" role="tablist">
            <TabButton active={tab === "conversation"} onClick={() => setTab("conversation")}>
              Conversation
              <TabCount value={detail.comments.length + detail.reviews.length + detail.threads.length} />
            </TabButton>
            <TabButton active={tab === "files"} onClick={() => setTab("files")}>
              Files
              <TabCount value={detail.changedFiles} />
            </TabButton>
            <TabButton active={tab === "commits"} onClick={() => setTab("commits")}>
              Commits
              <TabCount value={detail.commits.length} />
            </TabButton>
            <TabButton active={tab === "checks"} onClick={() => setTab("checks")}>
              Checks
              <TabCount value={detail.checks.length} tone={failingChecks > 0 ? "text-rust-400" : undefined} />
            </TabButton>
          </div>

          <div className="mt-4">
            {tab === "conversation" && (
              <ConversationTab
                detail={detail}
                timeline={timeline}
                now={now}
                busy={busy}
                act={act}
              />
            )}
            {tab === "files" && <FilesTab detail={detail} />}
            {tab === "commits" && <CommitsTab detail={detail} now={now} />}
            {tab === "checks" && <ChecksTab detail={detail} />}
          </div>
        </div>

        <aside className="flex min-w-0 flex-col gap-3">
          <MergeCard
            detail={detail}
            busy={busy}
            method={mergeMethod}
            onMethod={setMergeMethod}
            act={act}
          />

          <Card className="block shrink-0 px-4 py-3.5">
            <div className="grid grid-cols-2 gap-x-5 gap-y-3">
              <Field label="Author">{pull.author}</Field>
              <Field label="Opened">{relative(pull.createdAt, now)}</Field>
              <Field label="Commits">{detail.commits.length}</Field>
              <Field label="Files">{detail.changedFiles}</Field>
              <Field label="Changes">
                <span className="text-mint-400">+{detail.additions}</span>{" "}
                <span className="text-rust-400">-{detail.deletions}</span>
              </Field>
              <Field label="Threads">
                {detail.threads.length === 0
                  ? "none"
                  : unresolved === 0
                    ? "all resolved"
                    : `${unresolved} unresolved`}
              </Field>
            </div>
          </Card>

          {open && detail.checks.length > 0 && (
            <Card className="block shrink-0 px-4 py-3.5">
              <span className="plate text-haze-700">Checks</span>
              <ul className="mt-2 flex flex-col gap-1.5">
                {detail.checks.slice(0, 8).map((check, index) => (
                  <li key={`${check.name}-${index}`} className="flex items-center gap-2">
                    <CheckDot status={check.status} />
                    <span className="min-w-0 truncate text-[11.5px] text-haze-300" title={check.name}>
                      {check.name}
                    </span>
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-haze-600">
                      {check.status}
                    </span>
                  </li>
                ))}
              </ul>
              {detail.checks.length > 8 && (
                <p className="mt-1.5 text-[10.5px] text-haze-600">
                  and {detail.checks.length - 8} more under the Checks tab
                </p>
              )}
            </Card>
          )}
        </aside>
      </div>
    </div>
  );
}

function BackLink({ onBack }: { onBack: () => void }) {
  return (
    <a
      href="/pulls"
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        onBack();
      }}
      className="touch-target inline-flex items-center gap-1.5 text-[12px] font-medium text-haze-500 hover:text-haze-100"
    >
      <ArrowLeft className="size-3.5" />
      Pull requests
    </a>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`-mb-px flex shrink-0 touch-target cursor-pointer items-center gap-1.5 border-b-2 px-3 py-2 text-[12px] font-medium whitespace-nowrap transition-colors ${
        active ? "border-haze-50 text-haze-50" : "border-transparent text-haze-600 hover:text-haze-200"
      }`}
    >
      {children}
    </button>
  );
}

function TabCount({ value, tone }: { value: number; tone?: string }) {
  return (
    <span className={`font-mono text-[10.5px] leading-none ${tone ?? "text-haze-600"}`}>{value}</span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <span className="plate text-haze-700">{label}</span>
      <p className="mt-1 truncate font-mono text-[11px] text-haze-300">{children}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conversation

type TimelineItem =
  | { kind: "comment"; ts: string; comment: PullComment }
  | { kind: "review"; ts: string; review: PullReview }
  | { kind: "thread"; ts: string; thread: PullThread };

/** Comments, reviews, and review threads interleaved in the order they happened. */
function buildTimeline(detail: PullDetailResponse): TimelineItem[] {
  const items: TimelineItem[] = [
    ...detail.comments.map((comment): TimelineItem => ({ kind: "comment", ts: comment.createdAt, comment })),
    ...detail.reviews.map(
      (review): TimelineItem => ({ kind: "review", ts: review.submittedAt ?? "", review }),
    ),
    ...detail.threads.map(
      (thread): TimelineItem => ({ kind: "thread", ts: thread.comments[0]?.createdAt ?? "", thread }),
    ),
  ];
  return items.sort((a, b) => a.ts.localeCompare(b.ts));
}

type Act = (key: string, action: () => Promise<unknown>) => Promise<boolean>;

function ConversationTab({
  detail,
  timeline,
  now,
  busy,
  act,
}: {
  detail: PullDetailResponse;
  timeline: TimelineItem[];
  now: number;
  busy: string | null;
  act: Act;
}) {
  const { pull } = detail;
  return (
    <div className="flex flex-col gap-3">
      <Card className="block gap-0 overflow-hidden py-0">
        <div className="flex h-9 items-center gap-2 border-b border-ink-700 bg-ink-800/60 px-3">
          <span className="text-[12px] font-medium text-haze-200">{pull.author}</span>
          <span className="font-mono text-[10.5px] text-haze-600">
            opened {relative(pull.createdAt, now)}
          </span>
        </div>
        <div className="p-3.5">
          {detail.body.trim() ? (
            <Markdown>{detail.body}</Markdown>
          ) : (
            <p className="text-[12.5px] text-haze-600 italic">No description provided.</p>
          )}
        </div>
      </Card>

      {timeline.map((item, index) => {
        if (item.kind === "comment") {
          return <CommentCard key={`c-${item.comment.id}`} comment={item.comment} now={now} />;
        }
        if (item.kind === "review") {
          return <ReviewCard key={`r-${index}`} review={item.review} now={now} />;
        }
        return (
          <ThreadCard
            key={item.thread.id}
            repo={detail.pull.repo}
            number={detail.pull.number}
            thread={item.thread}
            now={now}
            busy={busy}
            act={act}
          />
        );
      })}

      <Composer detail={detail} busy={busy} act={act} />
    </div>
  );
}

function CommentCard({ comment, now }: { comment: PullComment; now: number }) {
  return (
    <Card className="block gap-0 overflow-hidden py-0">
      <div className="flex h-9 items-center gap-2 border-b border-ink-700 bg-ink-800/60 px-3">
        <span className="text-[12px] font-medium text-haze-200">{comment.author}</span>
        <span className="font-mono text-[10.5px] text-haze-600">
          commented {relative(comment.createdAt, now)}
        </span>
      </div>
      <div className="p-3.5">
        <Markdown>{comment.body}</Markdown>
      </div>
    </Card>
  );
}

/** GitHub review states worth colouring; anything else renders neutral. */
const REVIEW_TONE: Record<string, { label: string; className: string; icon?: "check" | "close" }> = {
  APPROVED: { label: "Approved", className: "border-mint-500/40 bg-mint-500/10 text-mint-400", icon: "check" },
  CHANGES_REQUESTED: {
    label: "Changes requested",
    className: "border-rust-500/40 bg-rust-500/10 text-rust-400",
    icon: "close",
  },
  COMMENTED: { label: "Commented", className: "border-ink-600 bg-ink-800/60 text-haze-400" },
  DISMISSED: { label: "Dismissed", className: "border-ink-600 bg-ink-800/60 text-haze-500" },
};

function ReviewCard({ review, now }: { review: PullReview; now: number }) {
  const tone = REVIEW_TONE[review.state] ?? {
    label: review.state.toLowerCase().replace(/_/g, " "),
    className: "border-ink-600 bg-ink-800/60 text-haze-400",
  };
  const body = review.body.trim();
  return (
    <Card className="block gap-0 overflow-hidden py-0">
      <div className="flex h-9 items-center gap-2 border-b border-ink-700 bg-ink-800/60 px-3">
        <span className="text-[12px] font-medium text-haze-200">{review.author}</span>
        <span className="font-mono text-[10.5px] text-haze-600">
          reviewed {review.submittedAt ? relative(review.submittedAt, now) : ""}
        </span>
        <Badge variant="outline" className={`ml-auto ${tone.className}`}>
          {tone.icon === "check" && <Check className="size-3" />}
          {tone.icon === "close" && <Close className="size-3" />}
          {tone.label}
        </Badge>
      </div>
      {body && (
        <div className="p-3.5">
          <Markdown>{body}</Markdown>
        </div>
      )}
    </Card>
  );
}

/** Lines of hunk context shown before the thread folds the earlier ones away. */
const HUNK_TAIL_LINES = 8;

function ThreadCard({
  repo,
  number,
  thread,
  now,
  busy,
  act,
}: {
  repo: string;
  number: number;
  thread: PullThread;
  now: number;
  busy: string | null;
  act: Act;
}) {
  const [expanded, setExpanded] = useState(false);
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
  const hunk = useMemo<DiffLine[]>(
    () => (thread.diffHunk ? parseUnifiedDiff(thread.diffHunk) : []),
    [thread.diffHunk],
  );
  // GitHub anchors a thread on its newest lines; fold the earlier context.
  const lines = expanded ? hunk : hunk.slice(Math.max(0, hunk.length - HUNK_TAIL_LINES));
  const hidden = hunk.length - lines.length;
  const anchor = thread.comments[0]?.id ?? 0;
  const resolveKey = `resolve:${thread.id}`;
  const replyKey = `reply:${thread.id}`;

  return (
    <Card className={`block gap-0 overflow-hidden py-0 ${thread.resolved ? "opacity-75" : ""}`}>
      <div className="flex h-9 items-center gap-2 border-b border-ink-700 bg-ink-800/60 px-3">
        <Doc className="size-3.5 shrink-0 text-haze-600" />
        <span className="min-w-0 truncate font-mono text-[11px] text-haze-200" title={thread.path}>
          {thread.path}
          {thread.line !== undefined && <span className="text-haze-500">:{thread.line}</span>}
        </span>
        {thread.outdated && <span className="plate shrink-0 text-haze-600">Outdated</span>}
        {thread.resolved && <span className="plate shrink-0 text-mint-400">Resolved</span>}
        <Button
          variant="ghost"
          size="plate"
          onClick={() =>
            void act(resolveKey, () => api.resolvePullThread(repo, number, thread.id, !thread.resolved))
          }
          disabled={busy !== null}
          className="ml-auto h-6 shrink-0 py-0 text-haze-500 hover:text-haze-100"
        >
          {busy === resolveKey ? "Saving" : thread.resolved ? "Unresolve" : "Resolve"}
        </Button>
      </div>

      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="block w-full cursor-pointer border-b border-ink-700/60 bg-ink-850 px-3 py-1 text-left font-mono text-[10.5px] text-haze-500 transition-colors hover:text-haze-200"
        >
          Show {hidden} earlier {hidden === 1 ? "line" : "lines"}
        </button>
      )}
      {lines.length > 0 && <DiffTable lines={lines} />}

      <ul className="flex flex-col divide-y divide-ink-700/60 border-t border-ink-700/60">
        {thread.comments.map((comment) => (
          <li key={comment.id || comment.createdAt} className="px-3 py-2.5">
            <p className="flex items-center gap-2">
              <span className="text-[12px] font-medium text-haze-200">{comment.author}</span>
              <span className="font-mono text-[10.5px] text-haze-600">
                {relative(comment.createdAt, now)}
              </span>
            </p>
            <div className="mt-1.5">
              <Markdown>{comment.body}</Markdown>
            </div>
          </li>
        ))}
      </ul>

      <div className="border-t border-ink-700/60 bg-ink-850 px-3 py-2">
        {replying ? (
          <div className="flex flex-col gap-2">
            <textarea
              value={reply}
              onChange={(event) => setReply(event.target.value)}
              placeholder="Reply to this thread"
              rows={3}
              autoFocus
              className="w-full resize-y rounded-md border border-ink-600 bg-ink-950/70 px-2.5 py-2 text-[12.5px] leading-relaxed text-haze-100 placeholder:text-haze-700 focus:border-ink-400 focus:outline-none"
            />
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="plate"
                disabled={busy !== null || !reply.trim() || anchor === 0}
                onClick={() =>
                  void act(replyKey, () => api.replyPull(repo, number, anchor, reply)).then((ok) => {
                    if (ok) {
                      setReply("");
                      setReplying(false);
                    }
                  })
                }
              >
                {busy === replyKey ? "Replying" : "Reply"}
              </Button>
              <Button
                variant="ghost"
                size="plate"
                onClick={() => setReplying(false)}
                disabled={busy === replyKey}
                className="text-haze-500"
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setReplying(true)}
            className="block w-full cursor-pointer rounded-md border border-ink-600 bg-ink-950/50 px-2.5 py-1.5 text-left text-[12px] text-haze-600 transition-colors hover:text-haze-300"
          >
            Reply to this thread
          </button>
        )}
      </div>
    </Card>
  );
}

function Composer({ detail, busy, act }: { detail: PullDetailResponse; busy: string | null; act: Act }) {
  const [text, setText] = useState("");
  const { repo, number } = detail.pull;
  const submit = (key: string, action: () => Promise<unknown>) =>
    void act(key, action).then((ok) => {
      if (ok) setText("");
    });

  return (
    <Card className="block gap-0 overflow-hidden py-0">
      <div className="flex h-9 items-center gap-2 border-b border-ink-700 bg-ink-800/60 px-3">
        <Plate className="text-haze-400">Add to the conversation</Plate>
      </div>
      <div className="flex flex-col gap-2 p-3">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Leave a comment (markdown works)"
          rows={4}
          className="w-full resize-y rounded-md border border-ink-600 bg-ink-950/70 px-2.5 py-2 text-[12.5px] leading-relaxed text-haze-100 placeholder:text-haze-700 focus:border-ink-400 focus:outline-none"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="plate"
            disabled={busy !== null || !text.trim()}
            onClick={() => submit("comment", () => api.commentPull(repo, number, text))}
          >
            {busy === "comment" ? "Commenting" : "Comment"}
          </Button>
          <span aria-hidden className="h-4 w-px shrink-0 bg-ink-700" />
          <Button
            variant="outline"
            size="plate"
            disabled={busy !== null}
            title="Approve the pull request, with the comment above when present"
            onClick={() => submit("approve", () => api.reviewPull(repo, number, "APPROVE", text))}
            className="border-mint-500/40 text-mint-400 hover:bg-mint-500/10 hover:text-mint-400"
          >
            <Check className="size-3" />
            {busy === "approve" ? "Approving" : "Approve"}
          </Button>
          <Button
            variant="outline"
            size="plate"
            disabled={busy !== null || !text.trim()}
            title="Request changes; the comment above becomes the review summary"
            onClick={() =>
              submit("request-changes", () => api.reviewPull(repo, number, "REQUEST_CHANGES", text))
            }
            className="border-rust-500/40 text-rust-400 hover:bg-rust-500/10 hover:text-rust-400"
          >
            {busy === "request-changes" ? "Requesting" : "Request changes"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Files, commits, checks

/** How many diff lines a file card shows before folding. */
const FILE_PREVIEW_LINES = 40;

function FilesTab({ detail }: { detail: PullDetailResponse }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="px-1 font-mono text-[11px] text-haze-500">
        {detail.changedFiles} {detail.changedFiles === 1 ? "file" : "files"}{" "}
        <span className="text-mint-400">+{detail.additions}</span>{" "}
        <span className="text-rust-400">-{detail.deletions}</span>
      </p>
      {detail.files.map((file) => (
        <FileCard key={file.path} file={file} />
      ))}
      {detail.files.length === 0 && (
        <p className="px-1 text-[12.5px] text-haze-600">No file changes reported.</p>
      )}
    </div>
  );
}

function FileCard({ file }: { file: PullFile }) {
  const [expanded, setExpanded] = useState(false);
  const diff = useMemo<DiffLine[]>(() => (file.patch ? parseUnifiedDiff(file.patch) : []), [file.patch]);
  const lines = expanded ? diff : diff.slice(0, FILE_PREVIEW_LINES);
  const hidden = diff.length - lines.length;

  return (
    <div className="overflow-hidden rounded-lg ring-1 ring-foreground/10">
      <div className="flex items-center gap-2 bg-ink-800/60 px-3 py-1.5">
        <Doc className="size-3.5 shrink-0 text-haze-600" />
        <span className="min-w-0 truncate font-mono text-[11.5px] text-haze-200" title={file.path}>
          {file.previousPath && (
            <span className="text-haze-500">
              {file.previousPath}
              {" → "}
            </span>
          )}
          {file.path}
        </span>
        {file.status !== "modified" && (
          <span
            className={`plate shrink-0 ${
              file.status === "added"
                ? "text-mint-400"
                : file.status === "removed"
                  ? "text-rust-400"
                  : "text-haze-500"
            }`}
          >
            {file.status}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] tabular-nums">
          {file.additions > 0 && <span className="text-mint-400">+{file.additions}</span>}
          {file.deletions > 0 && <span className="text-rust-400">-{file.deletions}</span>}
        </span>
      </div>
      {lines.length > 0 ? (
        <DiffTable lines={lines} />
      ) : (
        <p className="bg-ink-900/60 px-3 py-2 font-mono text-[10.5px] text-haze-600">
          No inline diff for this file (binary, or too large for GitHub to include).
        </p>
      )}
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

function CommitsTab({ detail, now }: { detail: PullDetailResponse; now: number }) {
  return (
    <ul className="flex flex-col overflow-hidden rounded-lg ring-1 ring-foreground/10">
      {detail.commits.map((commit) => (
        <li
          key={commit.sha}
          className="flex items-center gap-2.5 border-b border-ink-700/60 bg-card px-3 py-2 last:border-b-0"
        >
          <code className="shrink-0 font-mono text-[10.5px] text-haze-500">{commit.sha.slice(0, 7)}</code>
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-haze-200" title={commit.message}>
            {commit.message}
          </span>
          <span className="shrink-0 font-mono text-[10.5px] text-haze-600">
            {commit.author}
            {commit.date ? ` · ${relative(commit.date, now)}` : ""}
          </span>
        </li>
      ))}
      {detail.commits.length === 0 && (
        <li className="bg-card px-3 py-2 text-[12.5px] text-haze-600">No commits reported.</li>
      )}
    </ul>
  );
}

/** Check outcomes that read as red. */
function isFailure(status: string): boolean {
  return ["failure", "timed_out", "action_required", "error", "cancelled"].includes(status);
}

function isPendingCheck(status: string): boolean {
  return ["queued", "in_progress", "pending", "waiting", "requested"].includes(status);
}

function CheckDot({ status }: { status: string }) {
  const tone = isFailure(status)
    ? "bg-rust-500"
    : status === "success"
      ? "bg-mint-500"
      : isPendingCheck(status)
        ? "bg-ember-500 animate-beacon"
        : "bg-haze-600";
  return <span className={`inline-block size-[7px] shrink-0 rounded-full ${tone}`} />;
}

function ChecksTab({ detail }: { detail: PullDetailResponse }) {
  return (
    <div className="flex flex-col gap-3">
      {detail.checksLookupFailed && (
        <p className="px-1 text-[12px] text-haze-500">
          A status lookup failed, so this list may be incomplete.
        </p>
      )}
      <ul className="flex flex-col overflow-hidden rounded-lg ring-1 ring-foreground/10">
        {detail.checks.map((check, index) => (
          <li
            key={`${check.name}-${index}`}
            className="flex items-center gap-2.5 border-b border-ink-700/60 bg-card px-3 py-2 last:border-b-0"
          >
            <CheckDot status={check.status} />
            {check.url ? (
              <a
                href={check.url}
                target="_blank"
                rel="noreferrer"
                className="group flex min-w-0 flex-1 items-center gap-1.5 text-[12.5px] text-haze-200 hover:text-haze-50"
              >
                <span className="min-w-0 truncate">{check.name}</span>
                <External className="size-3 shrink-0 text-haze-700 group-hover:text-haze-300" />
              </a>
            ) : (
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-haze-200">{check.name}</span>
            )}
            <span
              className={`shrink-0 font-mono text-[10.5px] ${
                isFailure(check.status)
                  ? "text-rust-400"
                  : check.status === "success"
                    ? "text-mint-400"
                    : "text-haze-500"
              }`}
            >
              {check.status}
            </span>
          </li>
        ))}
        {detail.checks.length === 0 && (
          <li className="bg-card px-3 py-2 text-[12.5px] text-haze-600">
            {detail.checksLookupFailed ? "The checks lookup failed." : "No checks reported for the head commit."}
          </li>
        )}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Merge

const MERGE_METHODS: { id: PullMergeMethod; label: string }[] = [
  { id: "squash", label: "Squash and merge" },
  { id: "merge", label: "Create a merge commit" },
  { id: "rebase", label: "Rebase and merge" },
];

/** Human line for GitHub's mergeable_state. */
function mergeableText(state: string | undefined): { text: string; blocked: boolean } {
  switch (state) {
    case "clean":
      return { text: "No conflicts with the base branch.", blocked: false };
    case "unstable":
      return { text: "Checks are not passing, but merging is allowed.", blocked: false };
    case "has_hooks":
      return { text: "Mergeable, pending hooks.", blocked: false };
    case "dirty":
      return { text: "Conflicts with the base branch; resolve them on the branch first.", blocked: true };
    case "blocked":
      return { text: "Blocked by required reviews or checks.", blocked: true };
    case "behind":
      return { text: "The branch is behind the base and must be updated first.", blocked: true };
    case "draft":
      return { text: "Draft pull requests cannot merge.", blocked: true };
    default:
      return { text: "GitHub is still computing mergeability.", blocked: false };
  }
}

function MergeCard({
  detail,
  busy,
  method,
  onMethod,
  act,
}: {
  detail: PullDetailResponse;
  busy: string | null;
  method: PullMergeMethod;
  onMethod: (method: PullMergeMethod) => void;
  act: Act;
}) {
  const { repo, number, state } = detail.pull;

  if (state === "merged") {
    return (
      <Card className="block shrink-0 border-pr-merged/40 bg-pr-merged/8 px-4 py-3.5">
        <p className="flex items-center gap-2 text-[13px] font-medium text-pr-merged">
          <Merge className="size-4" />
          Merged
        </p>
        <p className="mt-1 text-[12px] leading-relaxed text-haze-400">
          The branch was merged into{" "}
          <code className="font-mono text-[11px]">{detail.pull.baseBranch}</code>. Nothing left to do
          here.
        </p>
      </Card>
    );
  }

  if (state === "closed") {
    return (
      <Card className="block shrink-0 px-4 py-3.5">
        <p className="flex items-center gap-2 text-[13px] font-medium text-pr-closed">
          <Close className="size-4" />
          Closed without merging
        </p>
        <Button
          variant="outline"
          size="plate"
          disabled={busy !== null}
          onClick={() => void act("reopen", () => api.reopenPull(repo, number))}
          className="mt-2.5"
        >
          {busy === "reopen" ? "Reopening" : "Reopen pull request"}
        </Button>
      </Card>
    );
  }

  const mergeable = mergeableText(detail.mergeableState);

  return (
    <Card className="block shrink-0 px-4 py-3.5">
      <span className="plate text-haze-700">Merge</span>

      {state === "draft" ? (
        <>
          <p className="mt-2 text-[12px] leading-relaxed text-haze-400">
            Still a draft. Mark it ready for review to enable merging.
          </p>
          <Button
            variant="outline"
            size="plate"
            disabled={busy !== null}
            onClick={() => void act("ready", () => api.readyPull(repo, number))}
            className="mt-2.5"
          >
            {busy === "ready" ? "Marking ready" : "Ready for review"}
          </Button>
        </>
      ) : (
        <>
          <p className={`mt-2 text-[12px] leading-relaxed ${mergeable.blocked ? "text-rust-400" : "text-haze-400"}`}>
            {mergeable.text}
          </p>
          <div className="mt-2.5 flex items-center gap-1.5">
            <Button
              variant="outline"
              size="plate"
              disabled={busy !== null || mergeable.blocked}
              onClick={() => void act("merge", () => api.mergePull(repo, number, method))}
              className="border-mint-500/40 text-mint-400 hover:bg-mint-500/10 hover:text-mint-400"
            >
              <Merge className="size-3" />
              {busy === "merge"
                ? "Merging"
                : (MERGE_METHODS.find((entry) => entry.id === method)?.label ?? "Merge")}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    aria-label="Choose merge method"
                    className="touch-target flex cursor-pointer items-center rounded-md border border-ink-600 px-1.5 py-1 text-haze-500 hover:text-haze-100"
                  />
                }
              >
                <ChevronRight className="size-3 rotate-90" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                <DropdownMenuRadioGroup
                  value={method}
                  onValueChange={(value) => onMethod(value as PullMergeMethod)}
                >
                  {MERGE_METHODS.map((entry) => (
                    <DropdownMenuRadioItem key={entry.id} value={entry.id}>
                      {entry.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </>
      )}

      <div className="mt-3 border-t border-ink-700/60 pt-2.5">
        <Button
          variant="ghost"
          size="plate"
          disabled={busy !== null}
          onClick={() => void act("close", () => api.closePull(repo, number))}
          className="text-haze-600 hover:text-rust-400"
          title="Close the pull request without merging"
        >
          <Branch className="size-3" />
          {busy === "close" ? "Closing" : "Close pull request"}
        </Button>
      </div>
    </Card>
  );
}
