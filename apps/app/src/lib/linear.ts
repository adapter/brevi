import type { BreviConfig, LinearStatus } from "@brevi/shared";

/**
 * Live Linear connectivity: trust linearStatus once it has arrived; before
 * that, fall back to the stored-key marker. "refresh-failing" counts as
 * connected: a credential is present, it is just temporarily degraded.
 */
export function linearConnected(config: BreviConfig | null, status: LinearStatus | null): boolean {
  if (status) return status.state === "connected" || status.state === "refresh-failing";
  return config !== null && config.linear.apiKey !== "";
}

/** The Linear connector needs the user's eyes: a dead credential, or a refresh that keeps failing. */
export function linearNeedsAttention(status: LinearStatus | null): boolean {
  return status?.state === "auth-error" || status?.state === "refresh-failing";
}
