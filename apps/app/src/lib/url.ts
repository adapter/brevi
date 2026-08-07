/**
 * Validates a URL received from the orchestrator before it is used for
 * client-side navigation (window.open, anchor hrefs). The URL is only
 * accepted when its origin exactly matches one of the trusted origins for
 * that flow; embedded credentials, unexpected hosts or ports, and non-http(s)
 * schemes (javascript:, data:, malformed input) all return null.
 */
export function safeExternalUrl(raw: string, trustedOrigins: string[]): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "") return null;
  return trustedOrigins.includes(url.origin) ? url.href : null;
}

/**
 * Normalizes a configured base URL (connect.apiBase) to the origin used for
 * the comparison above. Returns null when the value is empty, malformed, or
 * not http(s), so a bad config entry never widens the allowlist. http is
 * accepted on any host: self-hosted apps/api deployments are documented to
 * work over plain http, and the origin must still match exactly.
 */
export function trustedOriginOf(base: string): string | null {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url.origin;
}
