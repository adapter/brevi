import { LinearClient, type Issue, type LinearDocument } from "@linear/sdk";
import type { BreviConfig, LinearProject, Ticket, TicketKind } from "@brevi/shared";

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Linear integration: polls for eligible tickets, posts result comments, and
 * moves issues into a started state when a run begins.
 */
export class LinearService {
  #client: LinearClient;
  #config: BreviConfig;

  constructor(config: BreviConfig) {
    this.#config = config;
    // Personal API keys are sent raw; OAuth tokens (from the Connect flow) as Bearer.
    const key = config.linear.apiKey;
    this.#client = key.startsWith("lin_api_")
      ? new LinearClient({ apiKey: key })
      : new LinearClient({ accessToken: key });
  }

  /**
   * Issues assigned to the connected user in unstarted/backlog states that opt
   * in via the trigger label, mapped to the shared Ticket shape.
   */
  async fetchEligibleTickets(): Promise<Ticket[]> {
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

  /** Projects visible to the credential, for the dashboard's repo-mapping picker. */
  async listProjects(): Promise<LinearProject[]> {
    const connection = await this.#client.projects({ first: 250 });
    return connection.nodes
      .map((project) => ({ id: project.id, name: project.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Post a markdown comment on an issue; returns the comment url when available. */
  async postComment(issueId: string, markdown: string): Promise<string | undefined> {
    const payload = await this.#client.createComment({ issueId, body: markdown });
    const comment = payload.comment ? await payload.comment : undefined;
    return comment?.url;
  }

  /**
   * Move the issue to its team's first "started"-type state. Throws on
   * failure (after one retry) so callers can log the reason; the run itself
   * should still carry on.
   */
  async moveToStarted(issueId: string): Promise<void> {
    await this.#withRetry(async () => {
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
   * log the reason.
   */
  async moveToReview(issueId: string): Promise<boolean> {
    const reviewStateId = await this.#withRetry(async () => {
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
    });
    if (!reviewStateId) return false;

    // The GitHub integration's PR-opened automation may knock the issue back
    // to In Progress moments after the update above; wait out the webhook and
    // re-assert the review state if it no longer holds.
    for (const delay of REVIEW_REASSERT_DELAYS_MS) {
      await sleep(delay);
      await this.#withRetry(async () => {
        const issue = await this.#client.issue(issueId);
        const state = await issue.state;
        if (state?.id !== reviewStateId) await issue.update({ stateId: reviewStateId });
      });
    }
    return true;
  }

  /** Run a Linear API operation, retrying once after a short backoff. */
  async #withRetry<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch {
      await sleep(RETRY_DELAY_MS);
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

    const marker = trigger.spikeMarker.toLowerCase();
    const isSpike =
      marker.length > 0 &&
      (title.toLowerCase().includes(marker) || labels.some((l) => l.toLowerCase().includes(marker)));
    const kind: TicketKind = isSpike ? "spike" : "implementation";

    const state = await issue.state;
    const repo = await this.#resolveRepo(issue, labels);

    return {
      id: issue.id,
      identifier: issue.identifier,
      title,
      description,
      url: issue.url,
      kind,
      labels,
      state: state?.name ?? "Unknown",
      repo,
      updatedAt: issue.updatedAt.toISOString(),
    };
  }

  /**
   * Repo resolution order: a `repo:<key>` label, a label exactly matching a
   * repo key, the issue's project among a repo's configured `projects`, the
   * project name matching a key, then config.defaultRepo.
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
    const fallback = this.#config.defaultRepo;
    if (fallback && this.#config.repos[fallback]) return fallback;
    return undefined;
  }
}
