import type { CredentialResult } from "@brevi/shared";

/**
 * Validate a credential against its provider before saving it. Each validator
 * resolves to a CredentialResult rather than throwing: a bad key is a normal
 * outcome, not an exception. Agent keys are verified with a real 1-token
 * generation on the provider's cheapest model, so "connected" means "can
 * actually run the agent", not just "the key parses".
 */

/** Cheapest models used for liveness probes. */
const ANTHROPIC_PROBE_MODEL = "claude-haiku-4-5";
const OPENAI_PROBE_MODEL = "gpt-5-nano";

async function attempt(probe: () => Promise<string>): Promise<CredentialResult> {
  try {
    return { ok: true, detail: await probe() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const detail = /fetch failed|ENOTFOUND|ECONN|ETIMEDOUT/i.test(message)
      ? `could not reach the provider: ${message}`
      : message;
    return { ok: false, detail };
  }
}

export function validateLinearApiKey(apiKey: string): Promise<CredentialResult> {
  // Personal API keys are sent raw; OAuth access tokens use a Bearer prefix.
  const authorization = apiKey.startsWith("lin_api_") ? apiKey : `Bearer ${apiKey}`;
  return attempt(async () => {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: JSON.stringify({ query: "{ viewer { name email } }" }),
    });
    if (res.status === 401 || res.status === 400) throw new Error("Linear rejected this API key");
    if (!res.ok) throw new Error(`Linear returned ${res.status}`);
    const body = (await res.json()) as {
      data?: { viewer?: { name?: string; email?: string } };
      errors?: { message?: string }[];
    };
    const viewer = body.data?.viewer;
    if (!viewer) throw new Error(body.errors?.[0]?.message ?? "Linear rejected this API key");
    return `Connected as ${viewer.name ?? viewer.email ?? "unknown user"}`;
  });
}

export function validateGithubToken(token: string): Promise<CredentialResult> {
  return attempt(async () => {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "brevi",
      },
    });
    if (res.status === 401) throw new Error("GitHub rejected this token");
    if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
    const user = (await res.json()) as { login?: string };
    return `Connected as ${user.login ?? "unknown user"}`;
  });
}

/**
 * Verify an Anthropic credential with a 1-token message on the cheapest model.
 * API keys (sk-ant-...) authenticate via x-api-key; Claude Code OAuth tokens
 * via Authorization: Bearer plus the oauth beta header.
 */
export function validateAnthropicCredential(
  credential: string,
  kind: "api-key" | "oauth",
): Promise<CredentialResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (kind === "oauth") {
    headers.Authorization = `Bearer ${credential}`;
    headers["anthropic-beta"] = "oauth-2025-04-20";
  } else {
    headers["x-api-key"] = credential;
  }
  return attempt(async () => {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: ANTHROPIC_PROBE_MODEL,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    if (res.status === 401) throw new Error("Anthropic rejected this credential");
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      throw new Error(body?.error?.message ?? `Anthropic returned ${res.status}`);
    }
    return `Verified with ${ANTHROPIC_PROBE_MODEL}`;
  });
}

export function validateAnthropicApiKey(apiKey: string): Promise<CredentialResult> {
  return validateAnthropicCredential(apiKey, "api-key");
}

/**
 * Verify an OpenAI/Codex key with a 1-token completion on the cheapest model;
 * accounts without that model fall back to a plain auth check.
 */
export function validateCodexApiKey(apiKey: string): Promise<CredentialResult> {
  return attempt(async () => {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: OPENAI_PROBE_MODEL,
        messages: [{ role: "user", content: "ping" }],
        max_completion_tokens: 1,
      }),
    });
    if (res.status === 401) throw new Error("OpenAI rejected this API key");
    if (res.ok) return `Verified with ${OPENAI_PROBE_MODEL}`;
    // Model unavailable on this account: fall back to an auth-only check.
    const list = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (list.status === 401) throw new Error("OpenAI rejected this API key");
    if (!list.ok) throw new Error(`OpenAI returned ${list.status}`);
    return "API key verified";
  });
}
