import type {
  ConnectResponse,
  CredentialProvider,
  CredentialsUpdateRequest,
  CredentialsUpdateResponse,
  DevicePollResponse,
  ForgetMemoryRequest,
  GithubRepo,
  MemoriesResponse,
  HealthResponse,
  LinearProject,
  ConfigPatch,
  PrStatusResponse,
  R2ConnectResponse,
  R2Status,
  Run,
  RunEvent,
  SettingsUpdateResponse,
  Ticket,
} from "@brevi/shared";

/** Thin REST client. Everything is same-origin; Vite proxies /api to the orchestrator. */

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: { Accept: "application/json", ...init?.headers },
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
  followUpRun: (runId: string) =>
    json<Run>(`/api/runs/${encodeURIComponent(runId)}/followup`, { method: "POST" }),
  prStatus: (runId: string) => json<PrStatusResponse>(`/api/runs/${encodeURIComponent(runId)}/pr`),
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
};

export function artifactUrl(runId: string, name: string): string {
  return `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(name)}`;
}

export function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

/** Socket bridging the web terminal to a run's retained sandbox. */
export function attachWsUrl(runId: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws/runs/${encodeURIComponent(runId)}/attach`;
}
