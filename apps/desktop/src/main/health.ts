import { isHealthResponse, urlHost, type HealthResponse } from "@brevi/shared";

const DEFAULT_PROBE_TIMEOUT_MS = 2000;
const POLL_INTERVAL_MS = 500;

/** Base URL of the orchestrator's dashboard and API for a given config. */
export function orchestratorUrl(server: { host: string; port: number }): string {
  return `http://${urlHost(server.host)}:${server.port}`;
}

/** The brevi health payload from `url`, or null when nothing brevi answers there. */
export async function probeHealth(url: string, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<HealthResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/api/health`, { signal: controller.signal });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isHealthResponse(body) ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Polls probeHealth until it answers or `timeoutMs` elapses. */
export async function waitForHealth(url: string, timeoutMs: number): Promise<HealthResponse | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const health = await probeHealth(url);
    if (health) return health;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
