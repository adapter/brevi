import type {
  CredentialsUpdateRequest,
  CredentialsUpdateResponse,
  GithubRepo,
  HealthResponse,
  ReposUpdateRequest,
  ReposUpdateResponse,
  Run,
  RunEvent,
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
  updateCredentials: (request: CredentialsUpdateRequest) =>
    json<CredentialsUpdateResponse>("/api/settings/credentials", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }),
  githubRepos: () => json<GithubRepo[]>("/api/github/repos"),
  updateRepos: (request: ReposUpdateRequest) =>
    json<ReposUpdateResponse>("/api/settings/repos", {
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
