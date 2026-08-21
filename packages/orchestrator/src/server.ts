import { readFile } from "node:fs/promises";
import { createServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { createRequire } from "node:module";
import { totalmem } from "node:os";
import { extname } from "node:path";
import { serve, type HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocketServer, type WebSocket } from "ws";
import {
  isPlainObject,
  isSafePathSegment,
  loadConfig,
  redactConfig,
  resolveWithin,
  urlHost,
  WORKER_DEMAND_PATH,
  WORKER_SELF_STATE_PATH,
  WORKER_WS_PATH,
  type BreviConfig,
  type ClientMessage,
  type CredentialsUpdateRequest,
  type FollowUpRequest,
  type ForgetMemoryRequest,
  type HealthResponse,
  type HostExecution,
  type LinearStatus,
  type PullCommentRequest,
  type PullMergeRequest,
  type PullReplyRequest,
  type PullResolveRequest,
  type PullReviewRequest,
  type Run,
  type RunEvent,
  type ServerMessage,
  type SettingsUpdateRequest,
  type Ticket,
  type WorkerRenameRequest,
  type WorkerProvisionRequest,
  type WorkerProvisionResponse,
  type WorkerView,
} from "@brevi/shared";
import { attachOrchestratorLogFile } from "./logfile.js";
import { Orchestrator, OrchestratorError } from "./scheduler.js";
import { handleAttachSocket } from "./terminal.js";

export interface StartOptions {
  /** Pre-loaded config; when omitted, loaded from configPath. */
  config?: BreviConfig;
  configPath?: string;
  /** Random, per-launch credential required by the desktop management API. */
  managementToken?: string;
  /** Desktop-owned SSH provisioner. Omitted outside the desktop runtime. */
  provisionWorker?: (
    request: WorkerProvisionRequest & { pairingToken: string; workerHost: string },
  ) => Promise<WorkerProvisionResponse>;
  /**
   * Whether this machine can execute runs, and through what. Computed by
   * the booting desktop process, never by the orchestrator,
   * and surfaced verbatim on /api/health.
   */
  hostExecution?: HostExecution;
}

export interface OrchestratorHandle {
  port: number;
  url: string;
  /**
   * Mint or refresh the local worker's credential, in plaintext, for the
   * caller to inject into the child it is about to spawn. Every call
   * rotates it, invalidating whatever the previous call minted.
   */
  ensureLocalWorker(name: string): Promise<{ workerId: string; credential: string }>;
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

export function managementAuthorized(
  managementToken: string | undefined,
  authorization: string | undefined,
  queryToken: string | null,
): boolean {
  if (!managementToken) return true;
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
  return bearer === managementToken || queryToken === managementToken;
}

interface WorkerApiResult {
  status: 200 | 400 | 403 | 404;
  body: unknown;
}

/**
 * The worker-supervisor API, written once and served from both listeners: the
 * dashboard's (which covers a worker on this same machine, the default
 * loopback setup) and the fleet listener's (which is what a worker on
 * another machine can reach). Every other route on the dashboard listener is
 * protected by the desktop launch token; these two
 * cannot, since the caller runs wherever its worker does, so they
 * authenticate with that worker's own durable credential and reveal nothing
 * without it.
 *
 *   GET  WORKER_DEMAND_PATH?workerId=      -> FleetDemandResponse
 *        Deliberately answered while the worker is offline: deciding to boot
 *        a stopped machine is the whole reason a supervisor polls.
 *   POST WORKER_SELF_STATE_PATH?workerId=&state= -> FleetDemandResponse
 *        Drain or re-activate one's own worker, answered with the demand as
 *        it stands after the change. One round trip on purpose: a supervisor
 *        about to power its machine off needs the drain and the "what is
 *        still in flight" read to be the same operation, or a run dispatched
 *        between the two would be cut off mid-execution.
 *
 * Returns 404 for anything else, so the fleet listener can hand it every
 * request it receives and 404 whatever this declines.
 */
async function workerApi(
  orchestrator: Orchestrator,
  method: string,
  url: URL,
  authorization: string | undefined,
): Promise<WorkerApiResult> {
  const demand = url.pathname === WORKER_DEMAND_PATH && method === "GET";
  const setState = url.pathname === WORKER_SELF_STATE_PATH && method === "POST";
  if (!demand && !setState) return { status: 404, body: { error: "not found" } };

  const workerId = url.searchParams.get("workerId") ?? "";
  const credential = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  if (!workerId || !credential || !orchestrator.authenticateWorker(workerId, credential)) {
    return { status: 403, body: { error: "unknown worker, or a missing or wrong credential" } };
  }

  if (setState) {
    const state = url.searchParams.get("state");
    if (state !== "active" && state !== "draining") {
      return { status: 400, body: { error: 'state must be "active" or "draining"' } };
    }
    try {
      await orchestrator.setWorkerState(workerId, state);
    } catch {
      // Authentication just succeeded, so the only way here is a revoke
      // landing in between, which leaves nothing to set the state of.
      return { status: 403, body: { error: "this worker's enrollment is gone" } };
    }
  }

  return { status: 200, body: orchestrator.fleetDemand(workerId) };
}

function buildApp(
  orchestrator: Orchestrator,
  /**
   * The port actually listening, not `config.server.port`: the port is
   * editable from the dashboard and takes effect on restart, so the live
   * config can name a port nothing is bound to. OAuth redirect URIs have to
   * point at the socket that will receive the callback.
   */
  boundPort: () => number,
  /** See StartOptions.hostExecution; reported on /api/health verbatim when the booter supplied it. */
  hostExecution: HostExecution | undefined,
  managementToken: string | undefined,
  provisionWorker: StartOptions["provisionWorker"],
): Hono<{ Bindings: HttpBindings }> {
  const app = new Hono<{ Bindings: HttpBindings }>();

  app.use("/api/*", async (c, next) => {
    c.header("Access-Control-Allow-Origin", "brevi://app");
    c.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
    c.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (c.req.method === "OPTIONS") return c.body(null, 204);
    await next();
  });

  // The HTTP listener exists only as an implementation detail between the
  // Electron renderer and the orchestrator. A random launch token prevents a
  // normal browser process on the same machine from reaching management APIs.
  app.use("/api/*", async (c, next) => {
    const { pathname, searchParams } = new URL(c.req.url);
    if (
      !managementToken ||
      pathname === "/api/health" ||
      pathname === WORKER_DEMAND_PATH ||
      pathname === WORKER_SELF_STATE_PATH ||
      pathname === "/api/connect/linear/callback"
    ) {
      await next();
      return;
    }
    if (!managementAuthorized(managementToken, c.req.header("Authorization"), searchParams.get("token"))) {
      return c.json({ error: "desktop authorization required" }, 403);
    }
    await next();
  });

  app.get("/api/health", (c) => {
    const health: HealthResponse = {
      ok: true,
      version: VERSION,
      sandboxProvider: orchestrator.providerName,
      hostMemMib: Math.round(totalmem() / (1024 * 1024)),
    };
    if (hostExecution) health.hostExecution = hostExecution;
    return c.json(health);
  });

  // Read through the orchestrator: config is an immutable snapshot swapped on
  // every change, not a shared mutable object.
  app.get("/api/config", (c) => c.json(redactConfig(orchestrator.config)));

  app.get("/api/tickets", (c) => c.json(orchestrator.tickets));

  app.get("/api/workers", (c) => c.json({ workers: orchestrator.listWorkers() }));

  app.post("/api/workers/provision", async (c) => {
    if (!provisionWorker) return c.json({ error: "SSH provisioning is available only in the desktop app" }, 404);
    let request: WorkerProvisionRequest;
    try {
      request = (await c.req.json()) as WorkerProvisionRequest;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    try {
      const pairing = orchestrator.mintPairingToken();
      if (!pairing.remote) {
        throw new Error("the worker channel is not reachable remotely; configure its bind address and restart Mission Control");
      }
      return c.json(
        await provisionWorker({ ...request, pairingToken: pairing.token, workerHost: pairing.host }),
      );
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/api/workers/:id/rename", async (c) => {
    let body: WorkerRenameRequest;
    try {
      body = (await c.req.json()) as WorkerRenameRequest;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (typeof body?.name !== "string") return c.json({ error: "name must be a string" }, 400);
    try {
      return c.json(await orchestrator.renameWorker(c.req.param("id"), body.name));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, statusForError(error) as 400);
    }
  });

  app.post("/api/workers/:id/drain", async (c) => {
    try {
      return c.json(await orchestrator.setWorkerState(c.req.param("id"), "draining"));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, statusForError(error) as 400);
    }
  });

  app.post("/api/workers/:id/enable", async (c) => {
    try {
      return c.json(await orchestrator.setWorkerState(c.req.param("id"), "active"));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, statusForError(error) as 400);
    }
  });

  app.delete("/api/workers/:id", async (c) => {
    try {
      return c.json(await orchestrator.revokeWorker(c.req.param("id")));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, statusForError(error) as 400);
    }
  });

  const serveWorkerApi = async (c: { req: { url: string; method: string; header(name: string): string | undefined } }) => {
    const result = await workerApi(orchestrator, c.req.method, new URL(c.req.url), c.req.header("Authorization"));
    return result;
  };

  app.get(WORKER_DEMAND_PATH, async (c) => {
    const result = await serveWorkerApi(c);
    return c.json(result.body, result.status);
  });

  app.post(WORKER_SELF_STATE_PATH, async (c) => {
    const result = await serveWorkerApi(c);
    return c.json(result.body, result.status);
  });

  app.get("/api/runs", (c) => c.json(orchestrator.listRuns()));

  app.get("/api/usage", async (c) => {
    try {
      return c.json(await orchestrator.usage());
    } catch (error) {
      return c.json({ error: errorMessage(error) }, statusForError(error) as 400);
    }
  });

  app.get("/api/runs/:id", (c) => {
    const run = orchestrator.getRun(c.req.param("id"));
    if (!run) return c.json({ error: "run not found" }, 404);
    return c.json(run);
  });

  app.get("/api/runs/:id/events", async (c) => {
    const id = c.req.param("id");
    if (!isSafePathSegment(id)) return c.json({ error: "invalid run id" }, 400);
    if (!orchestrator.getRun(id)) return c.json({ error: "run not found" }, 404);
    // Opening a run's detail view is a natural moment to freshen its PR chip.
    void orchestrator.refreshPrState(id);
    return c.json(await orchestrator.getRunEvents(id));
  });

  app.get("/api/runs/:id/artifacts/:name", async (c) => {
    const id = c.req.param("id");
    const name = c.req.param("name");
    // Route params are URL-decoded after matching, so they can smuggle
    // separators; reject before the id or name touches a path.
    if (!isSafePathSegment(id)) return c.json({ error: "invalid run id" }, 400);
    if (!isSafePathSegment(name)) return c.json({ error: "invalid artifact name" }, 400);
    const run = orchestrator.getRun(id);
    if (!run) return c.json({ error: "run not found" }, 404);
    const path = resolveWithin(orchestrator.store.artifactsDir(id), name);
    if (!path) return c.json({ error: "invalid artifact name" }, 400);
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

  app.post("/api/runs/:id/archive", async (c) => {
    try {
      return c.json(await orchestrator.archiveRun(c.req.param("id")));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, statusForError(error) as 400);
    }
  });

  app.post("/api/runs/:id/unarchive", async (c) => {
    try {
      return c.json(await orchestrator.unarchiveRun(c.req.param("id")));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, statusForError(error) as 400);
    }
  });

  app.post("/api/runs/:id/followup", async (c) => {
    // The body is optional: a bare POST is the plain "take another look".
    const body = (await c.req.json().catch(() => ({}))) as FollowUpRequest;
    if (body?.instructions !== undefined && typeof body.instructions !== "string") {
      return c.json({ error: "instructions must be a string" }, 400);
    }
    const instructions = body?.instructions?.trim();
    if (instructions && instructions.length > 10_000) {
      return c.json({ error: "instructions must be 10000 characters or fewer" }, 400);
    }
    try {
      return c.json(await orchestrator.followUpRun(c.req.param("id"), instructions || undefined));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, statusForError(error) as 400);
    }
  });

  app.get("/api/runs/:id/pr", async (c) => {
    try {
      return c.json(await orchestrator.prStatus(c.req.param("id")));
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
    if (typeof body.xaiApiKey === "string") request.xaiApiKey = body.xaiApiKey;
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
    if (!["linear", "github", "anthropic", "codex", "grok"].includes(provider)) {
      return c.json({ error: "unknown provider" }, 404);
    }
    try {
      const serverUrl = `http://localhost:${boundPort()}`;
      return c.json(
        await orchestrator.connectProvider(
          provider as "linear" | "github" | "anthropic" | "codex" | "grok",
          serverUrl,
        ),
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

  app.get("/api/pulls", async (c) => {
    try {
      return c.json(await orchestrator.pulls.list());
    } catch (error) {
      return c.json({ error: errorMessage(error) }, statusForError(error) as 400);
    }
  });

  /** Shared parse for the /api/pulls/:repo/:number family. */
  const pullParams = (c: { req: { param(name: string): string | undefined } }) => {
    const repo = c.req.param("repo") ?? "";
    const number = Number(c.req.param("number"));
    if (!repo || !Number.isInteger(number) || number <= 0) return null;
    return { repo, number };
  };

  app.get("/api/pulls/:repo/:number", async (c) => {
    const params = pullParams(c);
    if (!params) return c.json({ error: "invalid repo or pull number" }, 400);
    try {
      return c.json(await orchestrator.pulls.detail(params.repo, params.number));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, statusForError(error) as 400);
    }
  });

  app.post("/api/pulls/:repo/:number/merge", async (c) => {
    const params = pullParams(c);
    if (!params) return c.json({ error: "invalid repo or pull number" }, 400);
    let body: PullMergeRequest;
    try {
      body = (await c.req.json()) as PullMergeRequest;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (!["merge", "squash", "rebase"].includes(body?.method)) {
      return c.json({ error: 'method must be "merge", "squash", or "rebase"' }, 400);
    }
    try {
      return c.json(await orchestrator.pulls.merge(params.repo, params.number, body.method));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, statusForError(error) as 400);
    }
  });

  app.post("/api/pulls/:repo/:number/close", async (c) => {
    const params = pullParams(c);
    if (!params) return c.json({ error: "invalid repo or pull number" }, 400);
    try {
      await orchestrator.pulls.setState(params.repo, params.number, "closed");
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, statusForError(error) as 400);
    }
  });

  app.post("/api/pulls/:repo/:number/reopen", async (c) => {
    const params = pullParams(c);
    if (!params) return c.json({ error: "invalid repo or pull number" }, 400);
    try {
      await orchestrator.pulls.setState(params.repo, params.number, "open");
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, statusForError(error) as 400);
    }
  });

  app.post("/api/pulls/:repo/:number/ready", async (c) => {
    const params = pullParams(c);
    if (!params) return c.json({ error: "invalid repo or pull number" }, 400);
    try {
      await orchestrator.pulls.ready(params.repo, params.number);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, statusForError(error) as 400);
    }
  });

  app.post("/api/pulls/:repo/:number/comment", async (c) => {
    const params = pullParams(c);
    if (!params) return c.json({ error: "invalid repo or pull number" }, 400);
    let body: PullCommentRequest;
    try {
      body = (await c.req.json()) as PullCommentRequest;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (typeof body?.body !== "string" || !body.body.trim()) {
      return c.json({ error: "body must be a non-empty string" }, 400);
    }
    try {
      await orchestrator.pulls.comment(params.repo, params.number, body.body);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, statusForError(error) as 400);
    }
  });

  app.post("/api/pulls/:repo/:number/review", async (c) => {
    const params = pullParams(c);
    if (!params) return c.json({ error: "invalid repo or pull number" }, 400);
    let body: PullReviewRequest;
    try {
      body = (await c.req.json()) as PullReviewRequest;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (!["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(body?.event)) {
      return c.json({ error: 'event must be "APPROVE", "REQUEST_CHANGES", or "COMMENT"' }, 400);
    }
    const text = typeof body.body === "string" ? body.body : "";
    // GitHub itself refuses these without a body; failing early keeps the message clear.
    if ((body.event === "REQUEST_CHANGES" || body.event === "COMMENT") && !text.trim()) {
      return c.json({ error: "this review event needs a comment body" }, 400);
    }
    try {
      await orchestrator.pulls.review(params.repo, params.number, body.event, text);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, statusForError(error) as 400);
    }
  });

  app.post("/api/pulls/:repo/:number/reply", async (c) => {
    const params = pullParams(c);
    if (!params) return c.json({ error: "invalid repo or pull number" }, 400);
    let body: PullReplyRequest;
    try {
      body = (await c.req.json()) as PullReplyRequest;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (!Number.isInteger(body?.commentId) || body.commentId <= 0) {
      return c.json({ error: "commentId must be a comment id" }, 400);
    }
    if (typeof body.body !== "string" || !body.body.trim()) {
      return c.json({ error: "body must be a non-empty string" }, 400);
    }
    try {
      await orchestrator.pulls.reply(params.repo, params.number, body.commentId, body.body);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, statusForError(error) as 400);
    }
  });

  app.post("/api/pulls/:repo/:number/resolve-thread", async (c) => {
    const params = pullParams(c);
    if (!params) return c.json({ error: "invalid repo or pull number" }, 400);
    let body: PullResolveRequest;
    try {
      body = (await c.req.json()) as PullResolveRequest;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (typeof body?.threadId !== "string" || !body.threadId || typeof body.resolved !== "boolean") {
      return c.json({ error: "threadId and resolved are required" }, 400);
    }
    try {
      await orchestrator.pulls.resolveThread(params.repo, body.threadId, body.resolved);
      return c.json({ ok: true });
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

  app.put("/api/settings", async (c) => {
    let body: SettingsUpdateRequest;
    try {
      body = (await c.req.json()) as SettingsUpdateRequest;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (!isPlainObject(body?.patch)) {
      return c.json({ error: "patch must be an object of config fields" }, 400);
    }
    try {
      return c.json(await orchestrator.updateSettings(body.patch));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, statusForError(error) as 400);
    }
  });

  app.get("/api/memories", (c) => c.json(orchestrator.listMemories()));

  app.post("/api/memories/:repo/forget", async (c) => {
    let body: ForgetMemoryRequest;
    try {
      body = (await c.req.json()) as ForgetMemoryRequest;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (typeof body?.id !== "string" || body.id === "") {
      return c.json({ error: "id must be a memory id" }, 400);
    }
    try {
      return c.json(await orchestrator.forgetMemory(c.req.param("repo"), body.id));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, statusForError(error) as 400);
    }
  });

  app.post("/api/memories/:repo/clear", async (c) => {
    try {
      return c.json(await orchestrator.clearMemories(c.req.param("repo")));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, statusForError(error) as 400);
    }
  });

  app.notFound((c) => c.json({ error: "not found" }, 404));

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
  managementToken: string | undefined,
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
    const url = new URL(request.url ?? "/", "http://localhost");
    const { pathname } = url;
    // Worker daemons dial in here; handed straight to the registry rather
    // than through the "connection" event, so it never reaches the dashboard
    // broadcast loop below (a worker socket speaks a different protocol
    // entirely and must not be mistaken for a dashboard client).
    if (pathname === WORKER_WS_PATH) {
      wss.handleUpgrade(request, socket, head, (ws) =>
        orchestrator.acceptWorkerSocket(ws, request.socket.remoteAddress),
      );
      return;
    }
    if (!managementAuthorized(managementToken, undefined, url.searchParams.get("token"))) {
      socket.destroy();
      return;
    }
    // Interactive terminal sockets are part of the desktop management
    // surface, so authorization happens before a sandbox is opened.
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
      config: redactConfig(orchestrator.config),
      linearStatus: orchestrator.linearStatus,
      workers: orchestrator.listWorkers(),
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
  const onWorkers = (workers: WorkerView[]): void => broadcast({ type: "workers", workers });
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
  orchestrator.on("workers", onWorkers);
  orchestrator.store.on("run-updated", onRunUpdated);
  orchestrator.store.on("run-event", onRunEvent);

  return {
    close(): void {
      orchestrator.off("tickets", onTickets);
      orchestrator.off("config", onConfig);
      orchestrator.off("linear-status", onLinearStatus);
      orchestrator.off("workers", onWorkers);
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
 * The worker channel's own listener, bound separately from the dashboard's
 * `server` (whose upgrade handler still serves WORKER_WS_PATH too, for a
 * worker on this same machine or an intentionally LAN-bound dashboard). It
 * answers every ordinary HTTP request with a 404 and upgrades nothing but
 * WORKER_WS_PATH: no dashboard, no management API, just the authenticated
 * worker protocol. Off when `config.fleet.host` is empty. A bind failure
 * (port in use, address not available) is logged and returns undefined rather
 * than throwing, so a bad fleet.host/port can't take the whole orchestrator
 * down.
 */
async function startFleetListener(
  orchestrator: Orchestrator,
  config: BreviConfig,
): Promise<{ close(): Promise<void> } | undefined> {
  if (!config.fleet.host) return undefined;

  const fleetWss = new WebSocketServer({ noServer: true });
  const httpServer = createServer((request, res) => {
    // The only plain requests answered here are the worker-supervisor ones:
    // they authenticate with a worker credential, exactly like the channel
    // this listener exists for, and a supervisor on the worker's machine has
    // no other listener it can reach. workerApi 404s everything else, so no
    // part of the management API is reachable through this port.
    const url = new URL(request.url ?? "/", "http://localhost");
    void workerApi(orchestrator, request.method ?? "GET", url, request.headers.authorization)
      .then((result) => {
        res.writeHead(result.status, { "content-type": "application/json" }).end(JSON.stringify(result.body));
      })
      .catch((error: unknown) => {
        console.error(`[brevi] fleet listener request failed: ${errorMessage(error)}`);
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "internal error" }));
      });
  });
  httpServer.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    if (pathname !== WORKER_WS_PATH) {
      socket.destroy();
      return;
    }
    fleetWss.handleUpgrade(request, socket, head, (ws) =>
      orchestrator.acceptWorkerSocket(ws, request.socket.remoteAddress),
    );
  });

  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      httpServer.once("error", rejectPromise);
      httpServer.listen(config.fleet.port, config.fleet.host, () => resolvePromise());
    });
  } catch (error) {
    console.error(
      `[brevi] fleet listener failed to bind ${config.fleet.host}:${config.fleet.port} (${errorMessage(error)}); workers can still enroll through the dashboard's own listener on this machine.`,
    );
    fleetWss.close();
    httpServer.close();
    return undefined;
  }
  // The bind's own "error" listener only ever rejects a promise that has
  // already resolved, and a server left with no listener at all throws on
  // the next error it emits: either way a socket-level failure here would go
  // unreported or take the whole process down over the fleet listener alone.
  httpServer.removeAllListeners("error");
  httpServer.on("error", (error) => {
    console.error(`[brevi] fleet listener error: ${errorMessage(error)}`);
  });

  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : config.fleet.port;
  orchestrator.setFleetEndpoint({ host: config.fleet.host, port });
  console.log(`[brevi] fleet listener bound at ${config.fleet.host}:${port}`);

  return {
    async close(): Promise<void> {
      // Every live worker socket has to be terminated before the server is
      // closed: an upgraded socket never ends on its own, and close() only
      // calls back once every connection has, so skipping this hangs
      // shutdown for as long as one worker stays connected. The registry's
      // own stop() does the same for the sockets it knows about, but it runs
      // later in the shutdown sequence and only ever sees registered
      // workers, not one still inside its register deadline.
      for (const client of fleetWss.clients) client.terminate();
      fleetWss.close();
      httpServer.closeAllConnections();
      await new Promise<void>((resolveClose) => httpServer.close(() => resolveClose()));
    },
  };
}

export async function startOrchestrator(options: StartOptions = {}): Promise<OrchestratorHandle> {
  attachOrchestratorLogFile();
  const loaded = options.config ?? (await loadConfig(options.configPath));
  // Mission Control is the only management client. Never honor an older
  // config that exposed the dashboard listener to a LAN.
  const config: BreviConfig = { ...loaded, server: { ...loaded.server, host: "127.0.0.1" } };
  const orchestrator = new Orchestrator(config, undefined, options.configPath);
  await orchestrator.start();

  // Filled in once the listener binds; the OAuth flows read it through the
  // getter rather than capturing a number that a settings save can outdate.
  let boundPort = config.server.port;
  const app = buildApp(
    orchestrator,
    () => boundPort,
    options.hostExecution,
    options.managementToken,
    options.provisionWorker,
  );
  const server = await new Promise<HttpServer>((resolvePromise, rejectPromise) => {
    const instance = serve(
      { fetch: app.fetch, port: config.server.port, hostname: config.server.host },
      () => resolvePromise(instance as HttpServer),
    ) as HttpServer;
    instance.once("error", rejectPromise);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.server.port;
  boundPort = port;
  // Both halves of what this listener really bound, captured here rather than
  // read back off the config later: `server.host` and `server.port` are
  // restart-required, so a saved change reaches the live config while this
  // socket stays where it is (see Orchestrator#dashboardEndpoint).
  orchestrator.setDashboardEndpoint({ host: config.server.host, port });
  const sockets = attachWebSockets(server, orchestrator, options.managementToken);
  const fleetListener = await startFleetListener(orchestrator, config);

  return {
    port,
    url: `http://${urlHost(config.server.host)}:${port}`,
    ensureLocalWorker: (name: string) => orchestrator.ensureLocalWorker(name),
    async stop(): Promise<void> {
      sockets.close();
      await fleetListener?.close();
      await orchestrator.stop();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    },
  };
}
