import type {
  ConnectResponse,
  CredentialProvider,
  CredentialsUpdateRequest,
  CredentialsUpdateResponse,
  DevicePollResponse,
  GithubRepo,
  HealthResponse,
  LinearProject,
  PrStatusResponse,
  R2ConnectResponse,
  R2SettingsUpdateRequest,
  R2SettingsUpdateResponse,
  R2Status,
  ReposUpdateRequest,
  ReposUpdateResponse,
  Run,
  RunEvent,
  SandboxSettingsUpdateRequest,
  SandboxSettingsUpdateResponse,
  Ticket,
} from "@brevi/shared";

/** Thin REST client. Everything is same-origin; Vite proxies /api to the orchestrator. */

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: { Accept: "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(body.trim() || `${res.status} ${res.statusText}`);
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
  updateRepos: (request: ReposUpdateRequest) =>
    json<ReposUpdateResponse>("/api/settings/repos", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }),
  updateSandboxSettings: (request: SandboxSettingsUpdateRequest) =>
    json<SandboxSettingsUpdateResponse>("/api/settings/sandbox", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }),
  r2Status: () => json<R2Status>("/api/connect/r2"),
  connectR2: () => json<R2ConnectResponse>("/api/connect/r2", { method: "POST" }),
  updateR2Settings: (request: R2SettingsUpdateRequest) =>
    json<R2SettingsUpdateResponse>("/api/settings/r2", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
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
