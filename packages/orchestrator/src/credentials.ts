import type { CredentialResult } from "@brevi/shared";

/**
 * Validate a credential against its provider before saving it. Each validator
 * resolves to a CredentialResult rather than throwing: a bad key is a normal
 * outcome, not an exception.
 */

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
  return attempt(async () => {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: apiKey },
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

export function validateAnthropicApiKey(apiKey: string): Promise<CredentialResult> {
  return attempt(async () => {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    });
    if (res.status === 401) throw new Error("Anthropic rejected this API key");
    if (!res.ok) throw new Error(`Anthropic returned ${res.status}`);
    return "API key verified";
  });
}

export function validateCodexApiKey(apiKey: string): Promise<CredentialResult> {
  return attempt(async () => {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.status === 401) throw new Error("OpenAI rejected this API key");
    if (!res.ok) throw new Error(`OpenAI returned ${res.status}`);
    return "API key verified";
  });
}
