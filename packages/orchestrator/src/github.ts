import { Octokit } from "octokit";
import type { GithubRepo } from "@brevi/shared";

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
}

/**
 * Open a PR and return its html_url. If a PR already exists for the branch
 * (rerun of a ticket), update its title/body and return the existing url.
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
  if (commitIdentityCache?.token !== token) {
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
