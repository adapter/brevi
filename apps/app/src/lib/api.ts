import type {
  ConnectResponse,
  CredentialProvider,
  CredentialsUpdateRequest,
  CredentialsUpdateResponse,
  DevicePollResponse,
  FleetResponse,
  ForgetMemoryRequest,
  GithubRepo,
  MemoriesResponse,
  HealthResponse,
  LinearProject,
  ConfigPatch,
  PrStatusResponse,
  PullCommentRequest,
  PullDetailResponse,
  PullListResponse,
  PullMergeMethod,
  PullMergeRequest,
  PullMergeResponse,
  PullReplyRequest,
  PullResolveRequest,
  PullReviewRequest,
  R2ConnectResponse,
  R2Status,
  Run,
  RunEvent,
  SettingsUpdateResponse,
  Ticket,
  UsageResponse,
  WorkerRenameRequest,
  WorkerProvisionRequest,
  WorkerProvisionResponse,
} from "@brevi/shared";

function desktopRuntime(): { apiBase: string; token: string } {
  const query = new URLSearchParams(window.location.search);
  return {
    apiBase: query.get("apiBase")?.replace(/\/$/, "") ?? "",
    token: query.get("token") ?? "",
  };
}

function apiUrl(path: string): string {
  return `${desktopRuntime().apiBase}${path}`;
}

/** Thin REST client for the private loopback API owned by Mission Control. */

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const { token } = desktopRuntime();
  const res = await fetch(apiUrl(input), {
    ...init,
    headers: {
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).trim();
    // The API reports failures as {"error": "..."}; surface the sentence, not
    // the envelope, so a validation message can be shown inline as-is.
    let detail = body;
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
        const { error } = parsed as { error: unknown };
        if (typeof error === "string" && error.trim()) detail = error.trim();
      }
    } catch {
      // Not JSON (an HTML error page, say); the raw text is the best we have.
    }
    throw new Error(detail || `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => json<HealthResponse>("/api/health"),
  runs: () => json<Run[]>("/api/runs"),
  tickets: () => json<Ticket[]>("/api/tickets"),
  events: (runId: string) => json<RunEvent[]>(`/api/runs/${encodeURIComponent(runId)}/events`),
  runTicket: (ticketId: string) =>
    json<Run>(`/api/tickets/${encodeURIComponent(ticketId)}/run`, { method: "POST" }),
  cancelRun: (runId: string) =>
    json<Run>(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" }),
  retryRun: (runId: string) =>
    json<Run>(`/api/runs/${encodeURIComponent(runId)}/retry`, { method: "POST" }),
  archiveRun: (runId: string) =>
    json<Run>(`/api/runs/${encodeURIComponent(runId)}/archive`, { method: "POST" }),
  unarchiveRun: (runId: string) =>
    json<Run>(`/api/runs/${encodeURIComponent(runId)}/unarchive`, { method: "POST" }),
  followUpRun: (runId: string) =>
    json<Run>(`/api/runs/${encodeURIComponent(runId)}/followup`, { method: "POST" }),
  prStatus: (runId: string) => json<PrStatusResponse>(`/api/runs/${encodeURIComponent(runId)}/pr`),
  pulls: () => json<PullListResponse>("/api/pulls"),
  pullDetail: (repoKey: string, number: number) =>
    json<PullDetailResponse>(`/api/pulls/${encodeURIComponent(repoKey)}/${number}`),
  mergePull: (repoKey: string, number: number, method: PullMergeMethod) =>
    json<PullMergeResponse>(`/api/pulls/${encodeURIComponent(repoKey)}/${number}/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method } satisfies PullMergeRequest),
    }),
  closePull: (repoKey: string, number: number) =>
    json<{ ok: true }>(`/api/pulls/${encodeURIComponent(repoKey)}/${number}/close`, { method: "POST" }),
  reopenPull: (repoKey: string, number: number) =>
    json<{ ok: true }>(`/api/pulls/${encodeURIComponent(repoKey)}/${number}/reopen`, { method: "POST" }),
  readyPull: (repoKey: string, number: number) =>
    json<{ ok: true }>(`/api/pulls/${encodeURIComponent(repoKey)}/${number}/ready`, { method: "POST" }),
  commentPull: (repoKey: string, number: number, body: string) =>
    json<{ ok: true }>(`/api/pulls/${encodeURIComponent(repoKey)}/${number}/comment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body } satisfies PullCommentRequest),
    }),
  reviewPull: (repoKey: string, number: number, event: PullReviewRequest["event"], body: string) =>
    json<{ ok: true }>(`/api/pulls/${encodeURIComponent(repoKey)}/${number}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, body } satisfies PullReviewRequest),
    }),
  replyPull: (repoKey: string, number: number, commentId: number, body: string) =>
    json<{ ok: true }>(`/api/pulls/${encodeURIComponent(repoKey)}/${number}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commentId, body } satisfies PullReplyRequest),
    }),
  resolvePullThread: (repoKey: string, number: number, threadId: string, resolved: boolean) =>
    json<{ ok: true }>(`/api/pulls/${encodeURIComponent(repoKey)}/${number}/resolve-thread`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId, resolved } satisfies PullResolveRequest),
    }),
  updateCredentials: (request: CredentialsUpdateRequest) =>
    json<CredentialsUpdateResponse>("/api/settings/credentials", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }),
  connect: (provider: CredentialProvider) =>
    json<ConnectResponse>(`/api/connect/${provider}`, { method: "POST" }),
  pollGithubDevice: () =>
    json<DevicePollResponse>("/api/connect/github/poll", { method: "POST" }),
  githubRepos: () => json<GithubRepo[]>("/api/github/repos"),
  linearProjects: () => json<LinearProject[]>("/api/linear/projects"),
  r2Status: () => json<R2Status>("/api/connect/r2"),
  connectR2: () => json<R2ConnectResponse>("/api/connect/r2", { method: "POST" }),
  memories: () => json<MemoriesResponse>("/api/memories"),
  /** Drop one memory, so it stops being handed to every future run in that repo. */
  forgetMemory: (repoKey: string, id: string) =>
    json<MemoriesResponse>(`/api/memories/${encodeURIComponent(repoKey)}/forget`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id } satisfies ForgetMemoryRequest),
    }),
  clearMemories: (repoKey: string) =>
    json<MemoriesResponse>(`/api/memories/${encodeURIComponent(repoKey)}/clear`, { method: "POST" }),
  /** The one write path for config.json: a deep-partial patch of one card's fields. */
  updateSettings: (patch: ConfigPatch) =>
    json<SettingsUpdateResponse>("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patch }),
    }),
  usage: () => json<UsageResponse>("/api/usage"),
  workers: () => json<FleetResponse>("/api/workers"),
  renameWorker: (id: string, name: string) =>
    json<FleetResponse>(`/api/workers/${encodeURIComponent(id)}/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name } satisfies WorkerRenameRequest),
    }),
  drainWorker: (id: string) =>
    json<FleetResponse>(`/api/workers/${encodeURIComponent(id)}/drain`, { method: "POST" }),
  enableWorker: (id: string) =>
    json<FleetResponse>(`/api/workers/${encodeURIComponent(id)}/enable`, { method: "POST" }),
  revokeWorker: (id: string) =>
    json<FleetResponse>(`/api/workers/${encodeURIComponent(id)}`, { method: "DELETE" }),
  provisionWorker: (request: WorkerProvisionRequest) =>
    json<WorkerProvisionResponse>("/api/workers/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }),
};

export function artifactUrl(runId: string, name: string): string {
  const { token } = desktopRuntime();
  const path = `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(name)}`;
  return `${apiUrl(path)}?token=${encodeURIComponent(token)}`;
}

export function wsUrl(): string {
  const { apiBase, token } = desktopRuntime();
  return `${apiBase.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`;
}

/** Socket bridging the web terminal to a run's retained sandbox. */
export function attachWsUrl(runId: string): string {
  const { apiBase, token } = desktopRuntime();
  return `${apiBase.replace(/^http/, "ws")}/ws/runs/${encodeURIComponent(runId)}/attach?token=${encodeURIComponent(token)}`;
}
