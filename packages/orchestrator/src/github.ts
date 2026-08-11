import { createHash, timingSafeEqual } from "node:crypto";
import { Octokit } from "octokit";
import type { GithubRepo, PrState } from "@brevi/shared";

export interface RemoteParts {
  owner: string;
  name: string;
}

/** Split an "owner/name" remote into its parts. */
export function parseRemote(remote: string): RemoteParts {
  const [owner, name] = remote.split("/");
  if (!owner || !name) throw new Error(`invalid repo remote "${remote}", expected "owner/name"`);
  return { owner, name };
}

/** HTTPS clone/push url with an embedded installation/user token. */
export function authenticatedRemote(remote: string, token: string): string {
  const { owner, name } = parseRemote(remote);
  return `https://x-access-token:${token}@github.com/${owner}/${name}.git`;
}

/** Plain HTTPS url without credentials, safe to leave in .git/config. */
export function plainRemote(remote: string): string {
  const { owner, name } = parseRemote(remote);
  return `https://github.com/${owner}/${name}.git`;
}

/** Repos visible to the token, most recently pushed first. */
export async function listRepos(token: string): Promise<GithubRepo[]> {
  const octokit = new Octokit({ auth: token });
  const repos = await octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
    sort: "pushed",
    direction: "desc",
    per_page: 100,
  });
  return repos.slice(0, 300).map((repo) => ({
    fullName: repo.full_name,
    defaultBranch: repo.default_branch ?? "main",
    private: repo.private,
    description: repo.description ?? "",
    pushedAt: repo.pushed_at ?? "",
  }));
}

export interface CreatePullRequestOptions {
  /** "owner/name" */
  remote: string;
  head: string;
  base: string;
  title: string;
  body: string;
  token: string;
  /** Open as a draft. Ignored when the PR already exists: draft state is only ever cleared by markPullRequestReady. */
  draft?: boolean;
}

/**
 * Open a PR and return its html_url. If a PR already exists for the branch
 * (rerun of a ticket, or the draft this run checkpointed earlier), update its
 * title/body and return the existing url.
 */
export async function createPullRequest(options: CreatePullRequestOptions): Promise<string> {
  const { owner, name } = parseRemote(options.remote);
  const octokit = new Octokit({ auth: options.token });
  try {
    const created = await octokit.rest.pulls.create({
      owner,
      repo: name,
      head: options.head,
      base: options.base,
      title: options.title,
      body: options.body,
      draft: options.draft ?? false,
    });
    return created.data.html_url;
  } catch (error) {
    if ((error as { status?: number }).status !== 422) throw error;
    const existing = await octokit.rest.pulls.list({
      owner,
      repo: name,
      head: `${owner}:${options.head}`,
      state: "open",
    });
    const pr = existing.data[0];
    if (!pr) throw error;
    await octokit.rest.pulls.update({
      owner,
      repo: name,
      pull_number: pr.number,
      title: options.title,
      body: options.body,
    });
    return pr.html_url;
  }
}

/**
 * Take a draft PR out of draft. Undrafting has no REST equivalent, so this
 * resolves the node id and uses the GraphQL mutation. A no-op when the PR is
 * already ready for review.
 */
export async function markPullRequestReady(prUrl: string, token: string): Promise<void> {
  const parsed = parsePrUrl(prUrl);
  if (!parsed) throw new Error(`not a github pull request url: "${prUrl}"`);
  const octokit = new Octokit({ auth: token });
  const pr = await octokit.rest.pulls.get({ owner: parsed.owner, repo: parsed.name, pull_number: parsed.number });
  if (!pr.data.draft) return;
  await octokit.graphql(
    `mutation ($id: ID!) {
      markPullRequestReadyForReview(input: { pullRequestId: $id }) {
        clientMutationId
      }
    }`,
    { id: pr.data.node_id },
  );
}

/**
 * Live state of the pull request at an html url. Returns null when the url
 * is not a GitHub PR url or GitHub cannot be reached, so a transient failure
 * never flips a stored state.
 */
export async function fetchPullRequestState(prUrl: string, token: string): Promise<PrState | null> {
  try {
    return (await fetchPrStatus(prUrl, token)).state;
  } catch {
    return null;
  }
}

/** Default branch reported by GitHub; used when repo config doesn't say. */
export async function defaultBranchOf(remote: string, token: string): Promise<string> {
  const { owner, name } = parseRemote(remote);
  const octokit = new Octokit({ auth: token });
  const repo = await octokit.rest.repos.get({ owner, repo: name });
  return repo.data.default_branch;
}

export interface CommitIdentity {
  /** git user.name */
  name: string;
  /** git user.email */
  email: string;
}

/** Synthetic identity used when the connected GitHub user cannot be resolved. */
export const FALLBACK_COMMIT_IDENTITY: CommitIdentity = { name: "brevi", email: "brevi@localhost" };

let commitIdentityCache: { token: string; promise: Promise<CommitIdentity | null>; warned: boolean } | undefined;

/**
 * Constant-time string equality for secrets. Both sides are hashed to
 * fixed-length digests first so timingSafeEqual can run even when the
 * inputs differ in length, without leaking where they diverge.
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

/** Actual GET /user lookup; never touches the cache. */
async function fetchCommitIdentity(token: string): Promise<CommitIdentity | null> {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "brevi",
      },
    });
    if (!res.ok) return null;
    const user = (await res.json()) as { login?: string; id?: number; name?: string | null };
    if (!user.login || typeof user.id !== "number") return null;
    return {
      name: user.name?.trim() || user.login,
      email: `${user.id}+${user.login}@users.noreply.github.com`,
    };
  } catch {
    return null;
  }
}

/**
 * Commit identity of the token's GitHub account: the account's display name
 * (or login) plus its noreply address, so run commits attribute to the
 * connected user without exposing a private email. The resolution (success
 * or failure) is cached for the process, keyed by token, so concurrent runs
 * share one in-flight GET /user request instead of each issuing their own;
 * reconnecting (a token change) re-resolves. On a cached failure, the
 * fallback warning callback fires only once per token.
 */
export async function resolveCommitIdentity(
  token: string,
  warnFallback?: (message: string) => void,
): Promise<CommitIdentity | null> {
  if (!commitIdentityCache || !timingSafeStringEqual(commitIdentityCache.token, token)) {
    commitIdentityCache = { token, promise: token ? fetchCommitIdentity(token) : Promise.resolve(null), warned: false };
  }
  const entry = commitIdentityCache;
  const identity = await entry.promise;
  if (identity === null && !entry.warned && warnFallback) {
    entry.warned = true;
    warnFallback(
      `could not resolve the connected GitHub user; committing as ${FALLBACK_COMMIT_IDENTITY.name} <${FALLBACK_COMMIT_IDENTITY.email}>`,
    );
  }
  return identity;
}

// Marks brevi's own PR comments so gathering feedback never feeds them back into itself.
const BREVI_MARKER = "Automated by [brevi]";

export interface PrStatus {
  url: string;
  number: number;
  state: PrState;
}

export interface PrThreadComment {
  author: string;
  body: string;
  createdAt: string;
}

/** One unresolved review thread with its file anchor and diff context. */
export interface PrReviewThread {
  path: string;
  line?: number;
  outdated: boolean;
  diffHunk?: string;
  comments: PrThreadComment[];
}

/** Everything a follow-up session needs to know about a PR's current state. */
export interface PrFeedback {
  url: string;
  number: number;
  state: PrState;
  baseBranch: string;
  headBranch: string;
  /** "owner/name" of the repository the head branch lives in; null when GitHub no longer knows it (e.g. a deleted fork). */
  headRepo: string | null;
  headSha: string;
  /** GitHub's mergeable_state, e.g. "clean", "dirty" (conflicts), "unstable". */
  mergeableState?: string;
  /** Unresolved review threads only. */
  threads: PrReviewThread[];
  /** Review summaries worth addressing: changes-requested, or any non-empty body. */
  reviews: { author: string; state: string; body: string; submittedAt?: string }[];
  /** Issue comments posted since the caller-supplied cutoff (the last brevi push). */
  comments: { author: string; body: string; createdAt: string }[];
  /** Check runs and commit statuses for the head sha, name plus outcome. */
  ci: { name: string; status: string }[];
  /** True when a CI status lookup failed, so `ci` may be incomplete rather than confirming that no checks exist. */
  ciLookupFailed: boolean;
}

/** Parse a github.com PR html url into its parts, or null when it isn't one. */
export function parsePrUrl(prUrl: string): { owner: string; name: string; number: number } | null {
  const match = prUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
  if (!match) return null;
  const [, owner, name, numberStr] = match;
  if (!owner || !name || !numberStr) return null;
  return { owner, name, number: Number(numberStr) };
}

/** Derive the open/draft/merged/closed state from a pulls.get-shaped response. */
function prStateOf(data: {
  merged?: boolean | null;
  merged_at?: string | null;
  draft?: boolean | null;
  state: string;
}): PrState {
  if (data.merged || data.merged_at) return "merged";
  if (data.state === "closed") return "closed";
  if (data.draft) return "draft";
  return "open";
}

/** Cheap open/draft/merged/closed lookup for the dashboard's button gating. */
export async function fetchPrStatus(prUrl: string, token: string): Promise<PrStatus> {
  const parsed = parsePrUrl(prUrl);
  if (!parsed) throw new Error(`not a github pull request url: "${prUrl}"`);
  const octokit = new Octokit({ auth: token });
  const pr = await octokit.rest.pulls.get({ owner: parsed.owner, repo: parsed.name, pull_number: parsed.number });
  return { url: prUrl, number: parsed.number, state: prStateOf(pr.data) };
}

interface ReviewThreadsQueryResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          id: string;
          isResolved: boolean;
          isOutdated: boolean;
          path: string;
          line: number | null;
          originalLine: number | null;
          comments: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: {
              author: { login: string } | null;
              body: string;
              diffHunk: string;
              createdAt: string;
            }[];
          };
        }[];
      };
    };
  };
}

/** Response shape for paging the remaining comments of a single thread by node id. */
interface ThreadCommentsQueryResponse {
  node: {
    comments: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: {
        author: { login: string } | null;
        body: string;
        diffHunk: string;
        createdAt: string;
      }[];
    };
  } | null;
}

/** Unresolved review threads for the PR, via GraphQL (REST has no resolved flag). Both the thread list and each thread's comments are paginated to exhaustion. */
async function fetchUnresolvedThreads(
  octokit: Octokit,
  owner: string,
  name: string,
  number: number,
): Promise<PrReviewThread[]> {
  type ThreadNode = ReviewThreadsQueryResponse["repository"]["pullRequest"]["reviewThreads"]["nodes"][number];

  const threadNodes: ThreadNode[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;
  while (hasNextPage) {
    const response: ReviewThreadsQueryResponse = await octokit.graphql<ReviewThreadsQueryResponse>(
      `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            reviewThreads(first: 100, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                isResolved
                isOutdated
                path
                line
                originalLine
                comments(first: 100) {
                  pageInfo { hasNextPage endCursor }
                  nodes {
                    author { login }
                    body
                    diffHunk
                    createdAt
                  }
                }
              }
            }
          }
        }
      }`,
      { owner, name, number, cursor },
    );
    const { nodes, pageInfo } = response.repository.pullRequest.reviewThreads;
    threadNodes.push(...nodes);
    hasNextPage = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor;
  }

  const threads: PrReviewThread[] = [];
  for (const thread of threadNodes) {
    if (thread.isResolved) continue;

    const comments = [...thread.comments.nodes];
    let commentsHasNextPage = thread.comments.pageInfo.hasNextPage;
    let commentsCursor = thread.comments.pageInfo.endCursor;
    while (commentsHasNextPage) {
      const response: ThreadCommentsQueryResponse = await octokit.graphql<ThreadCommentsQueryResponse>(
        `query($id: ID!, $cursor: String) {
          node(id: $id) {
            ... on PullRequestReviewThread {
              comments(first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  author { login }
                  body
                  diffHunk
                  createdAt
                }
              }
            }
          }
        }`,
        { id: thread.id, cursor: commentsCursor },
      );
      const more = response.node?.comments;
      if (!more) break;
      comments.push(...more.nodes);
      commentsHasNextPage = more.pageInfo.hasNextPage;
      commentsCursor = more.pageInfo.endCursor;
    }

    threads.push({
      path: thread.path,
      line: thread.line ?? thread.originalLine ?? undefined,
      outdated: thread.isOutdated,
      diffHunk: comments[0]?.diffHunk,
      comments: comments.map((comment) => ({
        author: comment.author?.login ?? "unknown",
        body: comment.body,
        createdAt: comment.createdAt,
      })),
    });
  }
  return threads;
}

/** Review summaries worth surfacing: changes-requested, or any non-empty, non-pending body. */
async function fetchReviewSummaries(
  octokit: Octokit,
  owner: string,
  name: string,
  number: number,
): Promise<PrFeedback["reviews"]> {
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, { owner, repo: name, pull_number: number, per_page: 100 });
  return reviews
    .filter((review) => review.state !== "PENDING" && (review.state === "CHANGES_REQUESTED" || (review.body ?? "").trim().length > 0))
    .filter((review) => !(review.body ?? "").includes(BREVI_MARKER))
    .map((review) => ({
      author: review.user?.login ?? "unknown",
      state: review.state,
      body: review.body ?? "",
      submittedAt: review.submitted_at ?? undefined,
    }));
}

/** Issue comments posted since `since`, excluding brevi's own. */
async function fetchCommentsSince(
  octokit: Octokit,
  owner: string,
  name: string,
  number: number,
  since: string | undefined,
): Promise<PrFeedback["comments"]> {
  // Without a push-time anchor from the caller, fetching would replay the whole comment history; skip instead.
  if (!since) return [];
  const comments = await octokit.paginate(octokit.rest.issues.listComments, { owner, repo: name, issue_number: number, since, per_page: 100 });
  return comments
    .filter((comment) => !(comment.body ?? "").includes(BREVI_MARKER))
    .map((comment) => ({
      author: comment.user?.login ?? "unknown",
      body: comment.body ?? "",
      createdAt: comment.created_at,
    }));
}

/**
 * Check runs and commit statuses for the head sha, each source paginated to exhaustion.
 * A lookup failure no longer masquerades as "no checks"; it is reported via `lookupFailed`
 * so the caller can tell an empty result from an incomplete one.
 */
async function fetchCiStatus(
  octokit: Octokit,
  owner: string,
  name: string,
  headSha: string,
): Promise<{ ci: PrFeedback["ci"]; lookupFailed: boolean }> {
  const ci: PrFeedback["ci"] = [];
  let lookupFailed = false;
  try {
    const checkRuns = await octokit.paginate(octokit.rest.checks.listForRef, { owner, repo: name, ref: headSha, per_page: 100 });
    for (const run of checkRuns) {
      ci.push({ name: run.name, status: run.conclusion ?? run.status });
    }
  } catch {
    // Repos without checks configured can 404 or return oddities; record the failure rather than fail the run.
    lookupFailed = true;
  }
  try {
    // octokit.paginate does not normalize getCombinedStatusForRef's `statuses` array reliably, so page manually.
    let page = 1;
    for (;;) {
      const statuses = await octokit.rest.repos.getCombinedStatusForRef({ owner, repo: name, ref: headSha, per_page: 100, page });
      for (const status of statuses.data.statuses) {
        ci.push({ name: status.context, status: status.state });
      }
      if (statuses.data.statuses.length < 100) break;
      page += 1;
    }
  } catch {
    // Same tolerance as check runs above.
    lookupFailed = true;
  }
  return { ci, lookupFailed };
}

/** Gather everything a follow-up session needs: rebase state, unresolved threads, reviews, comments, and CI. */
export async function gatherPrFeedback(options: { prUrl: string; token: string; commentsSince?: string }): Promise<PrFeedback> {
  const parsed = parsePrUrl(options.prUrl);
  if (!parsed) throw new Error(`not a github pull request url: "${options.prUrl}"`);
  const { owner, name, number } = parsed;
  const octokit = new Octokit({ auth: options.token });

  const pr = await octokit.rest.pulls.get({ owner, repo: name, pull_number: number });
  const headSha = pr.data.head.sha;

  // Threads/reviews/comments are the core payload; their errors propagate. Only CI degrades silently (reported via ciLookupFailed).
  const threads = await fetchUnresolvedThreads(octokit, owner, name, number);
  const reviews = await fetchReviewSummaries(octokit, owner, name, number);
  const comments = await fetchCommentsSince(octokit, owner, name, number, options.commentsSince);
  const { ci, lookupFailed: ciLookupFailed } = await fetchCiStatus(octokit, owner, name, headSha);

  return {
    url: options.prUrl,
    number,
    state: prStateOf(pr.data),
    baseBranch: pr.data.base.ref,
    headBranch: pr.data.head.ref,
    headRepo: pr.data.head.repo?.full_name ?? null,
    headSha,
    mergeableState: pr.data.mergeable_state ?? undefined,
    threads,
    reviews,
    comments,
    ci,
    ciLookupFailed,
  };
}

/** True when there is feedback for the agent to address (threads, review bodies, or comments). CI state alone is context, not a trigger. */
export function hasActionableFeedback(feedback: PrFeedback): boolean {
  return feedback.threads.length > 0 || feedback.reviews.length > 0 || feedback.comments.length > 0;
}

/** Render the bundle as markdown for the follow-up prompt, in full: bodies and diff hunks are never sliced. Includes mergeability/CI state; feedback sections appear only when non-empty. */
export function formatPrFeedback(feedback: PrFeedback): string {
  const lines: string[] = ["### Pull request state"];
  lines.push(`- Mergeable: ${feedback.mergeableState ?? "unknown"}`);
  if (feedback.ci.length > 0) {
    const ciSummary = feedback.ci.map((entry) => `${entry.name}: ${entry.status}`).join(", ");
    lines.push(`- CI: ${ciSummary}${feedback.ciLookupFailed ? " (may be incomplete: a status lookup failed)" : ""}`);
  } else if (feedback.ciLookupFailed) {
    lines.push("- CI: unknown (the status lookup failed)");
  } else {
    lines.push("- CI: no checks reported");
  }

  if (feedback.threads.length > 0) {
    lines.push("", `### Unresolved review threads (${feedback.threads.length})`);
    for (const thread of feedback.threads) {
      const location = thread.line !== undefined ? `${thread.path}:${thread.line}` : thread.path;
      lines.push("", `#### ${location}${thread.outdated ? " (outdated)" : ""}`);
      if (thread.diffHunk) lines.push("```diff", thread.diffHunk, "```");
      for (const comment of thread.comments) {
        lines.push(`- @${comment.author}: ${comment.body}`);
      }
    }
  }

  if (feedback.reviews.length > 0) {
    lines.push("", "### Review summaries");
    for (const review of feedback.reviews) {
      lines.push(`- @${review.author} (${review.state}): ${review.body}`);
    }
  }

  if (feedback.comments.length > 0) {
    lines.push("", "### Comments since the last push");
    for (const comment of feedback.comments) {
      lines.push(`- @${comment.author}: ${comment.body}`);
    }
  }

  return lines.join("\n");
}

/** Post a plain comment on the PR's issue thread, e.g. a follow-up session's reply. */
export async function postPrComment(options: { prUrl: string; token: string; body: string }): Promise<void> {
  const parsed = parsePrUrl(options.prUrl);
  if (!parsed) throw new Error(`not a github pull request url: "${options.prUrl}"`);
  const octokit = new Octokit({ auth: options.token });
  await octokit.rest.issues.createComment({
    owner: parsed.owner,
    repo: parsed.name,
    issue_number: parsed.number,
    body: options.body,
  });
}
