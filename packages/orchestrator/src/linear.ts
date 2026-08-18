import { setTimeout as delay } from "node:timers/promises";
import { LinearClient, LinearErrorType, type Issue, type LinearDocument } from "@linear/sdk";
import type { BreviConfig, LinearProject, Ticket } from "@brevi/shared";

/** Backoff before the single retry of a failed Linear API call. */
const RETRY_DELAY_MS = 2_000;

/**
 * After setting the review state, re-check it at these offsets and re-assert
 * if it changed. Linear's GitHub integration links the just-opened PR (via
 * the branch name and the "Fixes PD-x" magic word) and its "PR opened"
 * automation moves the issue back to In Progress a second or two after we
 * set In Review, silently clobbering the update.
 */
const REVIEW_REASSERT_DELAYS_MS = [5_000, 15_000];

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => delay(ms, undefined, { signal });

/**
 * True when a Linear API error means the stored credential no longer
 * authenticates (an expired/revoked OAuth token, or a rejected personal
 * key), as opposed to a transient network or server failure. Checked
 * structurally against the SDK's error `type` rather than `instanceof`,
 * since errors can cross unclear module boundaries; the regex is a fallback
 * for failures that never made it into a typed LinearError.
 */
export function isLinearAuthError(error: unknown): boolean {
  const type = (error as { type?: unknown } | null)?.type;
  if (type === LinearErrorType.AuthenticationError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /authentication required|not authenticated/i.test(message);
}

/**
 * How the scheduler hooks into authentication failures. Owned by the
 * scheduler so refresh stays single-flight across every caller (poll, the
 * dashboard's project list, a run posting its comment).
 */
export interface LinearAuthHooks {
  /**
   * Try to make the stored credential authenticate again (refresh the OAuth
   * token). True means the failed call is worth retrying once.
   */
  recover(): Promise<boolean>;
  /** The retry right after a successful recover was rejected too: the fresh credential is dead. */
  rejected(detail: string): void;
}

/**
 * Linear integration: polls for eligible tickets, posts result comments, and
 * moves issues into a started state when a run begins.
 */
export class LinearService {
  #clientInstance?: LinearClient;
  /** apiKey the current #clientInstance was built from, to detect a token refresh. */
  #clientKey?: string;
  #config: BreviConfig;
  #auth?: LinearAuthHooks;

  constructor(config: BreviConfig, auth?: LinearAuthHooks) {
    this.#config = config;
    this.#auth = auth;
  }

  /**
   * Rebuilds the client whenever config.linear.apiKey has moved on from what
   * it was built with. config is shared by reference and mutated in place
   * when scheduler.ts refreshes an OAuth token, so a run already in flight
   * must pick up the fresh token to post its final comment rather than fail
   * against the stale one.
   */
  get #client(): LinearClient {
    const key = this.#config.linear.apiKey;
    if (!this.#clientInstance || this.#clientKey !== key) {
      // Personal API keys are sent raw; OAuth tokens (from the Connect flow) as Bearer.
      this.#clientInstance = key.startsWith("lin_api_")
        ? new LinearClient({ apiKey: key })
        : new LinearClient({ accessToken: key });
      this.#clientKey = key;
    }
    return this.#clientInstance;
  }

  /**
   * Run a Linear operation with authentication recovery: on an auth error,
   * ask the scheduler to refresh the token, then retry the exact operation
   * once against the rebuilt client. Every public method goes through this,
   * so whichever call first hits an expired token recovers (or surfaces the
   * disconnection), not just the poll loop.
   */
  async #withAuthRecovery<T>(operation: () => Promise<T>): Promise<T> {
    const keyAtStart = this.#config.linear.apiKey;
    try {
      return await operation();
    } catch (error) {
      if (!isLinearAuthError(error) || !this.#auth) throw error;
      // The credential may have been replaced while the call was in flight
      // (a reconnect from the dashboard); retry against the current one
      // instead of asking to refresh a grant that no longer exists.
      const keyChanged = this.#config.linear.apiKey !== keyAtStart;
      if (!keyChanged && !(await this.#auth.recover())) throw error;
      try {
        return await operation();
      } catch (retryError) {
        // Rejected again right after a successful refresh: the fresh token
        // is dead too. Not conclusive when the key changed mid-call, so only
        // report the stable-credential case.
        if (!keyChanged && isLinearAuthError(retryError)) {
          this.#auth.rejected(
            retryError instanceof Error ? retryError.message : String(retryError),
          );
        }
        throw retryError;
      }
    }
  }

  /**
   * Issues assigned to the connected user in unstarted/backlog states that opt
   * in via the trigger label, mapped to the shared Ticket shape.
   */
  fetchEligibleTickets(): Promise<Ticket[]> {
    return this.#withAuthRecovery(() => this.#fetchEligibleTickets());
  }

  async #fetchEligibleTickets(): Promise<Ticket[]> {
    const filter: LinearDocument.IssueFilter = {
      assignee: { isMe: { eq: true } },
      state: { type: { in: ["unstarted", "backlog"] } },
    };
    if (this.#config.linear.teamKeys.length > 0) {
      filter.team = { key: { in: this.#config.linear.teamKeys } };
    }
    const connection = await this.#client.issues({ filter, first: 100 });
    const tickets: Ticket[] = [];
    for (const issue of connection.nodes) {
      const ticket = await this.#toTicket(issue);
      if (ticket) tickets.push(ticket);
    }
    return tickets;
  }

  /**
   * When each of the given issues completed or canceled, for issues that
   * have; issues still open are simply absent from the result. Feeds the
   * auto-archive sweep, which only asks about tickets it has not yet seen
   * close, so the same id is not re-queried sweep after sweep.
   */
  ticketClosures(ids: string[]): Promise<Map<string, string>> {
    return this.#withAuthRecovery(() => this.#ticketClosures(ids));
  }

  async #ticketClosures(ids: string[]): Promise<Map<string, string>> {
    const closures = new Map<string, string>();
    for (let offset = 0; offset < ids.length; offset += 50) {
      const connection = await this.#client.issues({
        filter: {
          id: { in: ids.slice(offset, offset + 50) },
          state: { type: { in: ["completed", "canceled"] } },
        },
        first: 50,
      });
      for (const issue of connection.nodes) {
        const closedAt = issue.completedAt ?? issue.canceledAt;
        if (closedAt) closures.set(issue.id, closedAt.toISOString());
      }
    }
    return closures;
  }

  /** Projects visible to the credential, for the dashboard's repo-mapping picker. */
  listProjects(): Promise<LinearProject[]> {
    return this.#withAuthRecovery(async () => {
      const connection = await this.#client.projects({ first: 250 });
      return connection.nodes
        .map((project) => ({ id: project.id, name: project.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  /** Post a markdown comment on an issue; returns the comment url when available. */
  postComment(issueId: string, markdown: string): Promise<string | undefined> {
    return this.#withAuthRecovery(async () => {
      const payload = await this.#client.createComment({ issueId, body: markdown });
      const comment = payload.comment ? await payload.comment : undefined;
      return comment?.url;
    });
  }

  /**
   * Move the issue to its team's first "started"-type state. Throws on
   * failure (after one retry) so callers can log the reason; the run itself
   * should still carry on.
   */
  async moveToStarted(issueId: string): Promise<void> {
    await this.#run(async () => {
      const issue = await this.#client.issue(issueId);
      const team = await issue.team;
      if (!team) return;
      const states = await team.states();
      const started = states.nodes
        .filter((state) => state.type === "started")
        .sort((a, b) => a.position - b.position)[0];
      if (started) await issue.update({ stateId: started.id });
    });
  }

  /**
   * After a successful run, move the issue to a review state, meaning the
   * team's first "started"-type state whose name mentions review (e.g. "In
   * Review"). Teams without one keep their current state. Returns whether a
   * review state was set; throws on failure (after one retry) so callers can
   * log the reason. Aborting `signal` interrupts the reassertion waits.
   */
  async moveToReview(issueId: string, signal?: AbortSignal): Promise<boolean> {
    const reviewStateId = await this.#run(async () => {
      const issue = await this.#client.issue(issueId);
      const team = await issue.team;
      if (!team) return undefined;
      const states = await team.states();
      const review = states.nodes
        .filter((state) => state.type === "started" && /review/i.test(state.name))
        .sort((a, b) => a.position - b.position)[0];
      if (!review) return undefined;
      await issue.update({ stateId: review.id });
      return review.id;
    }, signal);
    if (!reviewStateId) return false;

    // The GitHub integration's PR-opened automation may knock the issue back
    // to In Progress moments after the update above; wait out the webhook and
    // re-assert the review state if it no longer holds. Only a revert to
    // another "started"-type state is treated as the automation's doing; a
    // move to Done, Canceled, or the like is a legitimate concurrent
    // transition and is left alone.
    for (const wait of REVIEW_REASSERT_DELAYS_MS) {
      await sleep(wait, signal);
      await this.#run(async () => {
        const issue = await this.#client.issue(issueId);
        const state = await issue.state;
        if (state && state.id !== reviewStateId && state.type === "started") {
          await issue.update({ stateId: reviewStateId });
        }
      }, signal);
    }
    return true;
  }

  /** Transient retry plus authentication recovery around one state-transition operation. */
  #run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.#withAuthRecovery(() => this.#withRetry(operation, signal));
  }

  /** Run a Linear API operation, retrying once after a short backoff. */
  async #withRetry<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (signal?.aborted) throw error;
      await sleep(RETRY_DELAY_MS, signal);
      return await operation();
    }
  }

  async #toTicket(issue: Issue): Promise<Ticket | undefined> {
    const { trigger } = this.#config;
    const labels = (await issue.labels()).nodes.map((label) => label.name);
    const title = issue.title;
    const description = issue.description ?? "";

    const hasLabel = labels.some((l) => l.toLowerCase() === trigger.label.toLowerCase());
    if (!hasLabel) return undefined;

    const state = await issue.state;
    const repo = await this.#resolveRepo(issue, labels);

    return {
      id: issue.id,
      identifier: issue.identifier,
      title,
      description,
      url: issue.url,
      labels,
      state: state?.name ?? "Unknown",
      repo,
      updatedAt: issue.updatedAt.toISOString(),
    };
  }

  /**
   * Repo resolution order: a `repo:<key>` label, a label exactly matching a
   * repo key, the issue's project among a repo's configured `projects`, then
   * the project name matching a key.
   */
  async #resolveRepo(issue: Issue, labels: string[]): Promise<string | undefined> {
    const repoKeys = Object.keys(this.#config.repos);
    const byKey = (candidate: string): string | undefined =>
      repoKeys.find((key) => key.toLowerCase() === candidate.toLowerCase());

    for (const label of labels) {
      const match = /^repo:(.+)$/i.exec(label);
      if (!match?.[1]) continue;
      const key = byKey(match[1].trim());
      if (key) return key;
    }
    for (const label of labels) {
      const key = byKey(label);
      if (key) return key;
    }
    try {
      const project = await issue.project;
      if (project) {
        const name = project.name.toLowerCase();
        for (const [key, repo] of Object.entries(this.#config.repos)) {
          if (repo.projects.some((p) => p.toLowerCase() === name)) return key;
        }
        const key = byKey(project.name);
        if (key) return key;
      }
    } catch {
      // project lookup is optional
    }
    return undefined;
  }
}
