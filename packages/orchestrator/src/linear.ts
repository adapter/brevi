import { LinearClient, type Issue, type LinearDocument } from "@linear/sdk";
import type { BreviConfig, Ticket, TicketKind } from "@brevi/shared";

/**
 * Linear integration: polls for eligible tickets, posts result comments, and
 * moves issues into a started state when a run begins.
 */
export class LinearService {
  #client: LinearClient;
  #config: BreviConfig;

  constructor(config: BreviConfig) {
    this.#config = config;
    this.#client = new LinearClient({ apiKey: config.linear.apiKey });
  }

  /**
   * Issues assigned to the connected user in unstarted/backlog states that opt
   * in via the trigger label or tag, mapped to the shared Ticket shape.
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

  /** Post a markdown comment on an issue; returns the comment url when available. */
  async postComment(issueId: string, markdown: string): Promise<string | undefined> {
    const payload = await this.#client.createComment({ issueId, body: markdown });
    const comment = payload.comment ? await payload.comment : undefined;
    return comment?.url;
  }

  /** Best-effort: move the issue to its team's first "started"-type state. */
  async moveToStarted(issueId: string): Promise<void> {
    try {
      const issue = await this.#client.issue(issueId);
      const team = await issue.team;
      if (!team) return;
      const states = await team.states();
      const started = states.nodes
        .filter((state) => state.type === "started")
        .sort((a, b) => a.position - b.position)[0];
      if (started) await issue.update({ stateId: started.id });
    } catch {
      // best-effort by design
    }
  }

  async #toTicket(issue: Issue): Promise<Ticket | undefined> {
    const { trigger } = this.#config;
    const labels = (await issue.labels()).nodes.map((label) => label.name);
    const title = issue.title;
    const description = issue.description ?? "";

    const hasLabel = labels.some((l) => l.toLowerCase() === trigger.label.toLowerCase());
    const hasTag =
      trigger.tag.length > 0 && (title.includes(trigger.tag) || description.includes(trigger.tag));
    if (!hasLabel && !hasTag) return undefined;

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
   * repo key, the issue's project name matching a key, then config.defaultRepo.
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
