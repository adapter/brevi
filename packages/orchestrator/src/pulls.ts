import {
  commentOnPull,
  gatherPullDetail,
  listPullRequests,
  markPullRequestReady,
  mergePullRequest,
  replyToReviewComment,
  setPullRequestState,
  setReviewThreadResolved,
  submitPullReview,
} from "@brevi/integrations";
import type {
  BreviConfig,
  PullDetailResponse,
  PullListResponse,
  PullMergeMethod,
  PullMergeResponse,
  PullSummary,
} from "@brevi/shared";
import { OrchestratorError } from "./errors.js";

/**
 * The dashboard's GitHub pull request proxy: every method resolves the repo
 * and token from the live config, calls GitHub, and maps failures onto
 * OrchestratorError codes the routes serve. No scheduling state; the server
 * routes call this directly so the Orchestrator stays a scheduler.
 */
export class PullService {
  /** The live config object the Orchestrator mutates in place. */
  readonly #config: BreviConfig;

  constructor(config: BreviConfig) {
    this.#config = config;
  }

  /** The GitHub token, or the 400 every pull route answers without one. */
  #githubToken(): string {
    const token = this.#config.github.token;
    if (!token) throw new OrchestratorError("invalid", "GitHub is not connected");
    return token;
  }

  /** Resolve a repo key from config.repos to its "owner/name" remote. */
  #remote(repoKey: string): string {
    const repo = this.#config.repos[repoKey];
    if (!repo) throw new OrchestratorError("not-found", `no configured repository "${repoKey}"`);
    return repo.remote;
  }

  /** Map a GitHub API failure onto an orchestrator error the routes can serve. */
  static #wrapGithubError(error: unknown): OrchestratorError {
    const status = (error as { status?: number }).status;
    const message = `GitHub said: ${error instanceof Error ? error.message : String(error)}`;
    if (status === 404) return new OrchestratorError("not-found", message);
    // 405 (not mergeable) and 409 (head moved) are state conflicts, not bad input.
    if (status === 405 || status === 409) return new OrchestratorError("conflict", message);
    return new OrchestratorError("invalid", message);
  }

  /**
   * Pull requests across every configured repository, newest activity first.
   * Repos are fetched concurrently, and one failing repo (deleted remote,
   * token without access) reports its error beside the others' results
   * instead of failing the whole list.
   */
  async list(): Promise<PullListResponse> {
    const token = this.#githubToken();
    const repos = Object.entries(this.#config.repos);
    const settled = await Promise.all(
      repos.map(async ([key, repo]) => {
        try {
          const pulls = await listPullRequests(repo.remote, token);
          return { ok: true as const, key, remote: repo.remote, pulls };
        } catch (error) {
          return {
            ok: false as const,
            key,
            remote: repo.remote,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    const pulls: PullSummary[] = [];
    const errors: PullListResponse["errors"] = [];
    for (const result of settled) {
      if (result.ok) {
        for (const pull of result.pulls) pulls.push({ repo: result.key, ...pull });
      } else {
        errors.push({ repo: result.key, remote: result.remote, message: result.error });
      }
    }
    pulls.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { pulls, errors };
  }

  /** Everything the PR detail view renders, gathered from GitHub on demand. */
  async detail(repoKey: string, number: number): Promise<PullDetailResponse> {
    const token = this.#githubToken();
    const remote = this.#remote(repoKey);
    try {
      const detail = await gatherPullDetail(remote, number, token);
      return { ...detail, pull: { repo: repoKey, ...detail.pull } };
    } catch (error) {
      throw PullService.#wrapGithubError(error);
    }
  }

  async merge(repoKey: string, number: number, method: PullMergeMethod): Promise<PullMergeResponse> {
    const token = this.#githubToken();
    const remote = this.#remote(repoKey);
    try {
      return await mergePullRequest({ remote, number, method, token });
    } catch (error) {
      throw PullService.#wrapGithubError(error);
    }
  }

  async setState(repoKey: string, number: number, state: "open" | "closed"): Promise<void> {
    const token = this.#githubToken();
    const remote = this.#remote(repoKey);
    try {
      await setPullRequestState({ remote, number, state, token });
    } catch (error) {
      throw PullService.#wrapGithubError(error);
    }
  }

  /** Take the PR out of draft. */
  async ready(repoKey: string, number: number): Promise<void> {
    const token = this.#githubToken();
    const remote = this.#remote(repoKey);
    try {
      await markPullRequestReady(`https://github.com/${remote}/pull/${number}`, token);
    } catch (error) {
      throw PullService.#wrapGithubError(error);
    }
  }

  async comment(repoKey: string, number: number, body: string): Promise<void> {
    const token = this.#githubToken();
    const remote = this.#remote(repoKey);
    try {
      await commentOnPull({ remote, number, body, token });
    } catch (error) {
      throw PullService.#wrapGithubError(error);
    }
  }

  async review(
    repoKey: string,
    number: number,
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
    body: string,
  ): Promise<void> {
    const token = this.#githubToken();
    const remote = this.#remote(repoKey);
    try {
      await submitPullReview({ remote, number, event, body, token });
    } catch (error) {
      throw PullService.#wrapGithubError(error);
    }
  }

  async reply(repoKey: string, number: number, commentId: number, body: string): Promise<void> {
    const token = this.#githubToken();
    const remote = this.#remote(repoKey);
    try {
      await replyToReviewComment({ remote, number, commentId, body, token });
    } catch (error) {
      throw PullService.#wrapGithubError(error);
    }
  }

  async resolveThread(repoKey: string, threadId: string, resolved: boolean): Promise<void> {
    const token = this.#githubToken();
    // The thread node id already names the PR; the repo lookup just 404s early
    // on a key this config does not know.
    this.#remote(repoKey);
    try {
      await setReviewThreadResolved({ threadId, resolved, token });
    } catch (error) {
      throw PullService.#wrapGithubError(error);
    }
  }
}
