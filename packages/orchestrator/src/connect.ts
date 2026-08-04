import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import type { BreviConfig } from "@brevi/shared";

/**
 * Automatic credential acquisition for the dashboard's Connect buttons:
 * host discovery (gh CLI, Claude Code login, Codex login, env vars) and the
 * OAuth flows (GitHub device flow, Linear redirect flow). Validation happens
 * in the caller (scheduler) via credentials.ts.
 */

export interface DiscoveredCredential {
  value: string;
  /** Where it came from, for the "Connected via ..." detail. */
  source: string;
  /** "chatgpt" = a Codex CLI ChatGPT login (full auth.json blob, no API key). */
  kind: "api-key" | "oauth" | "chatgpt";
}

// --- Host discovery ----------------------------------------------------------

/** GitHub: the token of a logged-in `gh` CLI. */
export async function discoverGithubToken(): Promise<DiscoveredCredential | null> {
  try {
    const { stdout, exitCode } = await execa("gh", ["auth", "token"], {
      timeout: 5000,
      reject: false,
    });
    const token = stdout.trim();
    if (exitCode === 0 && token) return { value: token, source: "gh CLI", kind: "api-key" };
  } catch {
    // gh not installed
  }
  return null;
}

/**
 * Anthropic / Claude Code: env vars, then Claude Code's stored login
 * (macOS Keychain item "Claude Code-credentials", or ~/.claude/.credentials.json).
 */
export async function discoverAnthropicCredential(): Promise<DiscoveredCredential | null> {
  if (process.env.ANTHROPIC_API_KEY) {
    return { value: process.env.ANTHROPIC_API_KEY, source: "ANTHROPIC_API_KEY", kind: "api-key" };
  }
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return {
      value: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      source: "CLAUDE_CODE_OAUTH_TOKEN",
      kind: "oauth",
    };
  }

  const parseClaudeCredentials = (raw: string, source: string): DiscoveredCredential | null => {
    try {
      const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
      const token = parsed.claudeAiOauth?.accessToken;
      return token ? { value: token, source, kind: "oauth" } : null;
    } catch {
      return null;
    }
  };

  if (process.platform === "darwin") {
    try {
      const { stdout, exitCode } = await execa(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { timeout: 5000, reject: false },
      );
      if (exitCode === 0 && stdout.trim()) {
        const found = parseClaudeCredentials(stdout.trim(), "Claude Code login (Keychain)");
        if (found) return found;
      }
    } catch {
      // keychain unavailable
    }
  }
  try {
    const raw = await readFile(join(homedir(), ".claude", ".credentials.json"), "utf8");
    const found = parseClaudeCredentials(raw, "Claude Code login (~/.claude)");
    if (found) return found;
  } catch {
    // no credentials file
  }
  return null;
}

/**
 * Codex: OPENAI_API_KEY env, then ~/.codex/auth.json — which holds either an
 * API key or a ChatGPT OAuth login ({auth_mode, tokens: {access_token,
 * refresh_token, id_token, account_id}}). ChatGPT logins are captured whole:
 * the sandboxed Codex CLI consumes the file directly via CODEX_HOME.
 */
export async function discoverCodexCredential(): Promise<DiscoveredCredential | null> {
  if (process.env.OPENAI_API_KEY) {
    return { value: process.env.OPENAI_API_KEY, source: "OPENAI_API_KEY", kind: "api-key" };
  }
  try {
    const raw = await readFile(join(homedir(), ".codex", "auth.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      OPENAI_API_KEY?: string | null;
      tokens?: { access_token?: string } | null;
    };
    if (parsed.OPENAI_API_KEY) {
      return { value: parsed.OPENAI_API_KEY, source: "Codex CLI login", kind: "api-key" };
    }
    if (parsed.tokens?.access_token) {
      return { value: raw, source: "Codex CLI login (ChatGPT)", kind: "chatgpt" };
    }
  } catch {
    // no codex auth
  }
  return null;
}

// --- Hosted OAuth backend (apps/api on api.brevi.dev) ------------------------

/** Quick liveness probe so we never hand the dashboard a dead flow. */
export async function hostedApiReachable(apiBase: string): Promise<boolean> {
  if (!apiBase) return false;
  try {
    const res = await fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

// --- GitHub device flow ------------------------------------------------------

export interface GithubDeviceSession {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Seconds between polls (GitHub raises this on slow_down). */
  interval: number;
  expiresAt: number;
  /** Exactly one of these is set: a personal OAuth app, or the hosted backend. */
  clientId?: string;
  apiBase?: string;
}

export function githubClientId(config: BreviConfig): string {
  return config.connect.githubClientId;
}

interface DeviceCodeGrant {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export async function startGithubDeviceFlow(
  source: { clientId: string } | { apiBase: string },
): Promise<GithubDeviceSession> {
  const res =
    "clientId" in source
      ? await fetch("https://github.com/login/device/code", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ client_id: source.clientId, scope: "repo" }),
        })
      : await fetch(`${source.apiBase}/oauth/github/device/code`, { method: "POST" });
  if (!res.ok) throw new Error(`GitHub device authorization failed (${res.status})`);
  const body = (await res.json()) as DeviceCodeGrant;
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    interval: body.interval,
    expiresAt: Date.now() + body.expires_in * 1000,
    ...source,
  };
}

export type DevicePollOutcome =
  | { state: "pending" }
  | { state: "token"; token: string }
  | { state: "error"; detail: string };

export async function pollGithubDeviceFlow(
  session: GithubDeviceSession,
): Promise<DevicePollOutcome> {
  if (Date.now() > session.expiresAt) {
    return { state: "error", detail: "The device code expired. Start over." };
  }
  const res = session.apiBase
    ? await fetch(`${session.apiBase}/oauth/github/device/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: session.deviceCode }),
      })
    : await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_id: session.clientId,
          device_code: session.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });
  const body = (await res.json()) as { access_token?: string; error?: string; interval?: number };
  if (body.access_token) return { state: "token", token: body.access_token };
  switch (body.error) {
    case "authorization_pending":
      return { state: "pending" };
    case "slow_down":
      session.interval = body.interval ?? session.interval + 5;
      return { state: "pending" };
    case "access_denied":
      return { state: "error", detail: "Authorization was denied on GitHub." };
    case "expired_token":
      return { state: "error", detail: "The device code expired. Start over." };
    default:
      return { state: "error", detail: `GitHub returned ${body.error ?? res.status}` };
  }
}

// --- Linear OAuth redirect flow ----------------------------------------------

export interface LinearOauthApp {
  clientId: string;
  clientSecret: string;
}

export function linearOauthApp(config: BreviConfig): LinearOauthApp | null {
  const { linearClientId, linearClientSecret } = config.connect;
  return linearClientId && linearClientSecret
    ? { clientId: linearClientId, clientSecret: linearClientSecret }
    : null;
}

export interface LinearOauthSession {
  state: string;
  expiresAt: number;
  /** Exactly one of these is set: a personal OAuth app, or the hosted backend. */
  app?: { redirectUri: string } & LinearOauthApp;
  hosted?: { apiBase: string; port: number };
}

export function startLinearOauth(
  source: { app: LinearOauthApp; serverUrl: string } | { apiBase: string; port: number },
): { session: LinearOauthSession; url: string } {
  const state = randomBytes(16).toString("hex");
  const expiresAt = Date.now() + 10 * 60 * 1000;
  if ("app" in source) {
    const redirectUri = `${source.serverUrl}/api/connect/linear/callback`;
    const url = new URL("https://linear.app/oauth/authorize");
    url.searchParams.set("client_id", source.app.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "read,write");
    url.searchParams.set("state", state);
    url.searchParams.set("actor", "user");
    return {
      session: { state, expiresAt, app: { ...source.app, redirectUri } },
      url: url.toString(),
    };
  }
  const url = new URL(`${source.apiBase}/oauth/linear/authorize`);
  url.searchParams.set("state", state);
  url.searchParams.set("port", String(source.port));
  return {
    session: { state, expiresAt, hosted: { apiBase: source.apiBase, port: source.port } },
    url: url.toString(),
  };
}

export async function exchangeLinearCode(
  session: LinearOauthSession,
  code: string,
): Promise<string> {
  const res = session.hosted
    ? await fetch(`${session.hosted.apiBase}/oauth/linear/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, port: session.hosted.port }),
      })
    : await fetch("https://api.linear.app/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          redirect_uri: session.app?.redirectUri ?? "",
          client_id: session.app?.clientId ?? "",
          client_secret: session.app?.clientSecret ?? "",
          grant_type: "authorization_code",
        }),
      });
  if (!res.ok) throw new Error(`Linear token exchange failed (${res.status})`);
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("Linear returned no access token");
  return body.access_token;
}
