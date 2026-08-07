import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocketServer, type WebSocket } from "ws";
import {
  redactConfig,
  type BreviConfig,
  type ClientMessage,
  type CredentialsUpdateRequest,
  type HealthResponse,
  type LinearStatus,
  type R2SettingsUpdateRequest,
  type ReposUpdateRequest,
  type Run,
  type RunEvent,
  type SandboxSettingsUpdateRequest,
  type ServerMessage,
  type Ticket,
} from "@brevi/shared";
import { loadConfig } from "./config.js";
import { Orchestrator, OrchestratorError } from "./scheduler.js";
import { handleAttachSocket } from "./terminal.js";

export interface StartOptions {
  /** Pre-loaded config; when omitted, loaded from configPath. */
  config?: BreviConfig;
  configPath?: string;
  /**
   * Directory of the built dashboard to serve. When omitted, resolved from
   * the @brevi/app workspace package (the in-repo dev setup). The published
   * CLI bundles the dashboard and passes its own path here.
   */
  appDist?: string;
}

export interface OrchestratorHandle {
  port: number;
  url: string;
  stop(): Promise<void>;
}

const require = createRequire(import.meta.url);

const VERSION = ((): string => {
  try {
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".pdf": "application/pdf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

const PLACEHOLDER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>brevi</title></head>
<body style="font-family: system-ui; padding: 4rem; color: #333">
<h1>brevi</h1>
<p>The orchestrator is running, but the dashboard isn't built yet.</p>
<p>Run <code>bun run build</code> in <code>apps/app</code>, then restart.</p>
<p>The API is live at <a href="/api/health">/api/health</a>.</p>
</body></html>`;

/** Locate the built dashboard, or null when @brevi/app hasn't been built. */
function resolveAppDist(): string | null {
  try {
    const pkgPath = require.resolve("@brevi/app/package.json");
    const dist = join(dirname(pkgPath), "dist");
    return existsSync(join(dist, "index.html")) ? dist : null;
  } catch {
    return null;
  }
}

/** Tiny page shown in the popup after the Linear OAuth redirect. */
function connectResultPage(ok: boolean, detail: string): string {
  const title = ok ? "Linear connected" : "Connection failed";
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>brevi: ${title}</title></head>
<body style="font-family: system-ui; padding: 4rem; background: #101014; color: #e8e8ee">
<h1 style="font-size: 1.2rem">${title}</h1>
<p>${detail.replace(/</g, "&lt;")}</p>
<p style="color:#888">You can close this window and <a href="/config/connectors" style="color:#8ab4d8">return to the brevi dashboard</a>.</p>
</body></html>`;
}

function statusForError(error: unknown): number {
  if (error instanceof OrchestratorError) {
    if (error.code === "not-found") return 404;
    if (error.code === "conflict") return 409;
    if (error.code === "gone") return 410;
    return 400;
  }
  return 500;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildApp(orchestrator: Orchestrator, config: BreviConfig, appDist?: string): Hono {
  const app = new Hono();

  app.get("/api/health", (c) => {
    const health: HealthResponse = {
      ok: true,
      version: VERSION,
      sandboxProvider: orchestrator.providerName,
    };
    return c.json(health);
  });

  app.get("/api/config", (c) => c.json(redactConfig(config)));

  app.get("/api/tickets", (c) => c.json(orchestrator.tickets));

  app.get("/api/runs", (c) => c.json(orchestrator.listRuns()));

  app.get("/api/runs/:id", (c) => {
    const run = orchestrator.getRun(c.req.param("id"));
    if (!run) return c.json({ error: "run not found" }, 404);
    return c.json(run);
  });

  app.get("/api/runs/:id/events", async (c) => {
    const id = c.req.param("id");
    if (!orchestrator.getRun(id)) return c.json({ error: "run not found" }, 404);
    return c.json(await orchestrator.getRunEvents(id));
  });

  app.get("/api/runs/:id/artifacts/:name", async (c) => {
    const id = c.req.param("id");
    const name = c.req.param("name");
    const run = orchestrator.getRun(id);
    if (!run) return c.json({ error: "run not found" }, 404);
    const dir = orchestrator.store.artifactsDir(id);
    const path = resolve(dir, name);
    if (!path.startsWith(resolve(dir) + "/")) {
      return c.json({ error: "invalid artifact name" }, 400);
    }
    try {
      const bytes = await readFile(path);
      return c.body(new Uint8Array(bytes), 200, { "content-type": contentTypeFor(name) });
    } catch {
      return c.json({ error: "artifact not found" }, 404);
    }
  });

  app.post("/api/tickets/:id/run", async (c) => {
    try {
      return c.json(await orchestrator.queueTicket(c.req.param("id")));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, statusForError(error) as 400);
    }
  });

  app.post("/api/runs/:id/cancel", async (c) => {
    try {
      return c.json(await orchestrator.cancelRun(c.req.param("id")));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, statusForError(error) as 400);
    }
  });

  app.post("/api/runs/:id/retry", async (c) => {
    try {
      return c.json(await orchestrator.retryRun(c.req.param("id")));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, statusForError(error) as 400);
    }
  });

  app.post("/api/runs/:id/resume", async (c) => {
    try {
      return c.json(await orchestrator.resumeRun(c.req.param("id")));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, statusForError(error) as 400);
    }
  });

  app.post("/api/runs/:id/release", async (c) => {
    try {
      return c.json(await orchestrator.releaseRun(c.req.param("id")));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, statusForError(error) as 400);
    }
  });

  app.put("/api/settings/credentials", async (c) => {
    let body: CredentialsUpdateRequest;
    try {
      body = (await c.req.json()) as CredentialsUpdateRequest;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const request: CredentialsUpdateRequest = {};
    if (typeof body.linearApiKey === "string") request.linearApiKey = body.linearApiKey;
    if (typeof body.githubToken === "string") request.githubToken = body.githubToken;
    if (typeof body.anthropicApiKey === "string") request.anthropicApiKey = body.anthropicApiKey;
    if (typeof body.codexApiKey === "string") request.codexApiKey = body.codexApiKey;
    if (Object.keys(request).length === 0) {
      return c.json({ error: "no credentials provided" }, 400);
    }
    try {
      return c.json(await orchestrator.updateCredentials(request));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 500);
    }
  });

  app.get("/api/connect/r2", async (c) => {
    return c.json(await orchestrator.r2Status());
  });

  app.post("/api/connect/r2", async (c) => {
    return c.json(await orchestrator.connectR2());
  });

  app.post("/api/connect/:provider", async (c) => {
    const provider = c.req.param("provider");
    if (!["linear", "github", "anthropic", "codex"].includes(provider)) {
      return c.json({ error: "unknown provider" }, 404);
    }
    try {
      const serverUrl = `http://localhost:${config.server.port}`;
      return c.json(
        await orchestrator.connectProvider(provider as "linear" | "github" | "anthropic" | "codex", serverUrl),
      );
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 500);
    }
  });

  app.post("/api/connect/github/poll", async (c) => {
    try {
      return c.json(await orchestrator.pollGithubDevice());
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 500);
    }
  });

  app.get("/api/connect/linear/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.html(connectResultPage(false, "Missing code or state."), 400);
    const result = await orchestrator.completeLinearOauth(state, code);
    return c.html(connectResultPage(result.ok, result.detail), result.ok ? 200 : 400);
  });

  app.get("/api/github/repos", async (c) => {
    try {
      return c.json(await orchestrator.listGithubRepos());
    } catch (error) {
      return c.json({ error: errorMessage(error) }, statusForError(error) as 400);
    }
  });

  app.get("/api/linear/projects", async (c) => {
    try {
      return c.json(await orchestrator.listLinearProjects());
    } catch (error) {
      return c.json({ error: errorMessage(error) }, statusForError(error) as 400);
    }
  });

  app.put("/api/settings/repos", async (c) => {
    let body: ReposUpdateRequest;
    try {
      body = (await c.req.json()) as ReposUpdateRequest;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (typeof body.repos !== "object" || body.repos === null || Array.isArray(body.repos)) {
      return c.json({ error: "repos must be an object of key -> repo config" }, 400);
    }
    try {
      return c.json(await orchestrator.updateRepos(body));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, statusForError(error) as 400);
    }
  });

  app.put("/api/settings/sandbox", async (c) => {
    let body: SandboxSettingsUpdateRequest;
    try {
      body = (await c.req.json()) as SandboxSettingsUpdateRequest;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (typeof body.concurrency !== "number") {
      return c.json({ error: "concurrency must be a number" }, 400);
    }
    try {
      return c.json(await orchestrator.updateSandboxSettings({ concurrency: body.concurrency }));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, statusForError(error) as 400);
    }
  });

  app.put("/api/settings/r2", async (c) => {
    let body: R2SettingsUpdateRequest;
    try {
      body = (await c.req.json()) as R2SettingsUpdateRequest;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const request: R2SettingsUpdateRequest = {};
    if (typeof body.bucket === "string") request.bucket = body.bucket;
    if (typeof body.publicBaseUrl === "string") request.publicBaseUrl = body.publicBaseUrl;
    if (Object.keys(request).length === 0) {
      return c.json({ error: "no r2 settings provided" }, 400);
    }
    try {
      return c.json(await orchestrator.updateR2Settings(request));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, statusForError(error) as 400);
    }
  });

  app.notFound(async (c) => {
    // Everything outside /api serves the dashboard SPA.
    const { pathname } = new URL(c.req.url);
    if (c.req.method !== "GET" || pathname.startsWith("/api/")) {
      return c.json({ error: "not found" }, 404);
    }
    const dist = appDist ?? resolveAppDist();
    if (!dist) return c.html(PLACEHOLDER_HTML);

    const requested = resolve(dist, `.${decodeURIComponent(pathname)}`);
    const candidates =
      requested.startsWith(resolve(dist)) && pathname !== "/" ? [requested] : [];
    candidates.push(join(dist, "index.html"));
    for (const candidate of candidates) {
      try {
        const bytes = await readFile(candidate);
        return c.body(new Uint8Array(bytes), 200, { "content-type": contentTypeFor(candidate) });
      } catch {
        // fall through to the next candidate
      }
    }
    return c.html(PLACEHOLDER_HTML);
  });

  return app;
}

interface WsClient {
  socket: WebSocket;
  /** Empty set = receive all run events; otherwise only these run ids. */
  subscriptions: Set<string>;
}

function attachWebSockets(
  server: HttpServer,
  orchestrator: Orchestrator,
  config: BreviConfig,
): { close(): void } {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WsClient>();

  const send = (socket: WebSocket, message: ServerMessage): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };
  const broadcast = (message: ServerMessage): void => {
    for (const client of clients) send(client.socket, message);
  };

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    // Interactive web-terminal sockets for a run's retained sandbox.
    const attachMatch = /^\/ws\/runs\/([^/]+)\/attach$/.exec(pathname);
    if (attachMatch) {
      const runId = decodeURIComponent(attachMatch[1] ?? "");
      wss.handleUpgrade(request, socket, head, (ws) => handleAttachSocket(ws, orchestrator, runId));
      return;
    }
    if (pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  };
  server.on("upgrade", onUpgrade);

  wss.on("connection", (socket: WebSocket) => {
    const client: WsClient = { socket, subscriptions: new Set() };
    clients.add(client);
    send(socket, {
      type: "hello",
      runs: orchestrator.listRuns(),
      tickets: orchestrator.tickets,
      config: redactConfig(config),
      linearStatus: orchestrator.linearStatus,
    });
    socket.on("message", (data) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(String(data)) as ClientMessage;
      } catch {
        return;
      }
      if (message.type === "subscribe") client.subscriptions.add(message.runId);
      else if (message.type === "unsubscribe") client.subscriptions.delete(message.runId);
    });
    socket.on("close", () => clients.delete(client));
    socket.on("error", () => clients.delete(client));
  });

  const onTickets = (tickets: Ticket[]): void => broadcast({ type: "tickets", tickets });
  const onConfig = (redacted: BreviConfig): void => broadcast({ type: "config", config: redacted });
  const onLinearStatus = (linearStatus: LinearStatus): void =>
    broadcast({ type: "linear-status", linearStatus });
  const onRunUpdated = (run: Run): void => broadcast({ type: "run-updated", run });
  const onRunEvent = (event: RunEvent): void => {
    for (const client of clients) {
      if (client.subscriptions.size > 0 && !client.subscriptions.has(event.runId)) continue;
      send(client.socket, { type: "run-event", event });
    }
  };
  orchestrator.on("tickets", onTickets);
  orchestrator.on("config", onConfig);
  orchestrator.on("linear-status", onLinearStatus);
  orchestrator.store.on("run-updated", onRunUpdated);
  orchestrator.store.on("run-event", onRunEvent);

  return {
    close(): void {
      orchestrator.off("tickets", onTickets);
      orchestrator.off("config", onConfig);
      orchestrator.off("linear-status", onLinearStatus);
      orchestrator.store.off("run-updated", onRunUpdated);
      orchestrator.store.off("run-event", onRunEvent);
      server.off("upgrade", onUpgrade);
      for (const client of clients) client.socket.terminate();
      clients.clear();
      wss.close();
    },
  };
}

/**
 * The host to advertise in the handle URL: wildcard binds map to localhost so
 * the browser-open flow works, and IPv6 literals get their URL brackets.
 */
function displayHost(host: string): string {
  if (["0.0.0.0", "::", "::0", "0:0:0:0:0:0:0:0", "::1"].includes(host) || host.startsWith("127.")) {
    return "localhost";
  }
  return host.includes(":") ? `[${host}]` : host;
}

export async function startOrchestrator(options: StartOptions = {}): Promise<OrchestratorHandle> {
  const config = options.config ?? (await loadConfig(options.configPath));
  const orchestrator = new Orchestrator(config, undefined, options.configPath);
  await orchestrator.start();

  const app = buildApp(orchestrator, config, options.appDist);
  const server = await new Promise<HttpServer>((resolvePromise, rejectPromise) => {
    const instance = serve(
      { fetch: app.fetch, port: config.server.port, hostname: config.server.host },
      () => resolvePromise(instance as HttpServer),
    ) as HttpServer;
    instance.once("error", rejectPromise);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.server.port;
  const sockets = attachWebSockets(server, orchestrator, config);

  return {
    port,
    url: `http://${displayHost(config.server.host)}:${port}`,
    async stop(): Promise<void> {
      sockets.close();
      await orchestrator.stop();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    },
  };
}
