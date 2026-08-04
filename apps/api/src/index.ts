import { Hono } from "hono";
import { cors } from "hono/cors";

/**
 * brevi's hosted OAuth backend (api.brevi.dev).
 *
 * Local brevi orchestrators use these endpoints so one-click Connect works
 * without every user registering their own OAuth apps. This worker holds
 * brevi's registered app credentials; the Linear client secret never leaves
 * it. No user tokens are stored — every response goes straight back to the
 * requesting orchestrator, which persists them in the user's ~/.brevi.
 */

interface Env {
  GITHUB_CLIENT_ID: string;
  LINEAR_CLIENT_ID: string;
  LINEAR_CLIENT_SECRET: string;
}

/** Local orchestrator callback ports we mint Linear redirect URIs for. */
function validPort(raw: string | undefined): number | null {
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}

function linearRedirectUri(port: number): string {
  return `http://localhost:${port}/api/connect/linear/callback`;
}

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());

app.get("/", (c) =>
  c.json({
    service: "brevi-api",
    docs: "https://github.com/adapterlabs/brevi",
    endpoints: [
      "GET /health",
      "POST /oauth/github/device/code",
      "POST /oauth/github/device/token",
      "GET /oauth/linear/authorize?state=&port=",
      "POST /oauth/linear/token",
    ],
  }),
);

app.get("/health", (c) => c.json({ ok: true, service: "brevi-api" }));

// --- GitHub device flow (proxied so brevi's client id ships server-side) -----

app.post("/oauth/github/device/code", async (c) => {
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: c.env.GITHUB_CLIENT_ID, scope: "repo" }),
  });
  if (!res.ok) return c.json({ error: `GitHub returned ${res.status}` }, 502);
  // Passes through: device_code, user_code, verification_uri, expires_in, interval.
  return c.json(await res.json());
});

app.post("/oauth/github/device/token", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { device_code?: string } | null;
  if (!body?.device_code) return c.json({ error: "device_code is required" }, 400);
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: c.env.GITHUB_CLIENT_ID,
      device_code: body.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  // Passes through: access_token on success, or GitHub's error/interval fields
  // (authorization_pending, slow_down, expired_token, access_denied).
  return c.json(await res.json(), res.ok ? 200 : 502);
});

// --- Linear OAuth (authorization code; the secret stays in this worker) ------

app.get("/oauth/linear/authorize", (c) => {
  const state = c.req.query("state");
  const port = validPort(c.req.query("port"));
  if (!state || !port) return c.json({ error: "state and port are required" }, 400);
  const url = new URL("https://linear.app/oauth/authorize");
  url.searchParams.set("client_id", c.env.LINEAR_CLIENT_ID);
  url.searchParams.set("redirect_uri", linearRedirectUri(port));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "read,write");
  url.searchParams.set("state", state);
  url.searchParams.set("actor", "user");
  return c.redirect(url.toString(), 302);
});

app.post("/oauth/linear/token", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    code?: string;
    port?: number;
  } | null;
  const port = validPort(body?.port !== undefined ? String(body.port) : undefined);
  if (!body?.code || !port) return c.json({ error: "code and port are required" }, 400);
  const res = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: body.code,
      redirect_uri: linearRedirectUri(port),
      client_id: c.env.LINEAR_CLIENT_ID,
      client_secret: c.env.LINEAR_CLIENT_SECRET,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) return c.json({ error: `Linear token exchange failed (${res.status})` }, 502);
  const token = (await res.json()) as { access_token?: string };
  if (!token.access_token) return c.json({ error: "Linear returned no access token" }, 502);
  return c.json({ access_token: token.access_token });
});

export default app;
