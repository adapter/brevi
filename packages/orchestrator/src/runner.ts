import { copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { execa, type Result as ExecaResult } from "execa";
import { WORKSPACES_DIR, type ArtifactRef, type BreviConfig, type RepoConfig, type RunResult, type Ticket } from "@brevi/shared";
import type { Sandbox, SandboxProvider } from "@brevi/sandbox";
import { authenticatedRemote, createPullRequest, plainRemote } from "./github.js";
import { LinearService } from "./linear.js";
import { buildImplementationPrompt, buildSpikePrompt } from "./prompts.js";
import type { RunStore } from "./state.js";

const MAX_COMMENT_BYTES = 60 * 1024;
const BREVI_FOOTER = "🤖 Automated by [brevi]";

export class RunCancelledError extends Error {
  constructor() {
    super("run cancelled");
    this.name = "RunCancelledError";
  }
}

export interface RunContext {
  runId: string;
  config: BreviConfig;
  store: RunStore;
  provider: SandboxProvider;
  linear: LinearService;
  signal: AbortSignal;
}

/**
 * The full run pipeline: prepare a checkout + sandbox, run the coding agent,
 * then finalize (PR for implementations, Linear comment for spikes).
 *
 * Never throws for run failures: every outcome lands in the store as a
 * terminal status. Only truly unexpected store errors can escape.
 */
export async function executeRun(ctx: RunContext): Promise<void> {
  const { config, store, provider, linear, signal } = ctx;
  const run = store.get(ctx.runId);
  if (!run) throw new Error(`unknown run ${ctx.runId}`);
  const ticket = run.ticket;

  const tempRoot = join(WORKSPACES_DIR, run.id);
  const checkoutDir = join(tempRoot, "checkout");
  const pulledDir = join(tempRoot, "out");
  let sandbox: Sandbox | undefined;

  const log = (stream: "stdout" | "stderr" | "system", text: string): void => {
    store.appendEvent({ runId: run.id, ts: new Date().toISOString(), type: "log", stream, text });
  };

  try {
    // ---- preparing -------------------------------------------------------
    await store.setStatus(run.id, "preparing", { startedAt: new Date().toISOString() });
    throwIfAborted(signal);

    const repoKey = ticket.repo;
    const repo = repoKey ? config.repos[repoKey] : undefined;
    if (!repoKey || !repo) {
      throw new Error(`ticket ${ticket.identifier} has no resolved repo mapping`);
    }
    const agentEnv = collectAgentEnv(config);
    const branch = branchNameFor(ticket);

    await mkdir(tempRoot, { recursive: true });
    log("system", `cloning ${repo.remote} (${repo.path ? `local: ${repo.path}` : "remote"})`);
    const cloneSource = repo.path ?? authenticatedRemote(repo.remote, config.github.token);
    await git(["clone", "--depth", "50", "--branch", repo.defaultBranch, cloneSource, checkoutDir], tempRoot, config.github.token);
    // Never ship credentials into the sandbox via .git/config.
    await git(["remote", "set-url", "origin", plainRemote(repo.remote)], checkoutDir, config.github.token);
    await git(["checkout", "-B", branch], checkoutDir, config.github.token);
    await git(["config", "user.name", "brevi"], checkoutDir, config.github.token);
    await git(["config", "user.email", "brevi@localhost"], checkoutDir, config.github.token);
    throwIfAborted(signal);

    log("system", `creating ${provider.name} sandbox`);
    sandbox = await provider.create({ id: run.id, env: agentEnv });
    await store.update(run.id, { sandbox: { provider: provider.name, id: sandbox.id } });
    await sandbox.pushDirectory(checkoutDir, sandbox.workspacePath);
    // A Codex ChatGPT login travels as a file, not an env var: the Codex CLI
    // reads $CODEX_HOME/auth.json. Kept inside the workspace so every provider
    // can write it; scrubbed again before anything is committed.
    let codexHome: string | undefined;
    if (config.agent.codexAuthJson) {
      codexHome = `${sandbox.workspacePath}/${CODEX_HOME_DIR}`;
      await sandbox.exec("mkdir", ["-p", codexHome]);
      await sandbox.writeFile(`${codexHome}/auth.json`, config.agent.codexAuthJson);
    }
    await linear.moveToStarted(ticket.id);
    throwIfAborted(signal);

    // ---- running ---------------------------------------------------------
    await store.setStatus(run.id, "running");
    const prompt =
      ticket.kind === "spike"
        ? buildSpikePrompt(ticket)
        : buildImplementationPrompt(ticket, repo, config.github.prDescription);
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"];
    if (config.agent.model) args.push("--model", config.agent.model);
    args.push(...config.agent.args);

    const stdoutSink = lineSink((line) => {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        log("stdout", line);
        return;
      }
      store.appendEvent({ runId: run.id, ts: new Date().toISOString(), type: "agent", event });
    });
    const stderrSink = lineSink((line) => log("stderr", line));

    log("system", `running ${config.agent.command} (timeout ${config.sandbox.timeoutMinutes}m)`);
    const exec = await raceWithAbort(
      sandbox.exec(config.agent.command, args, {
        cwd: sandbox.workspacePath,
        env: codexHome ? { CODEX_HOME: codexHome } : undefined,
        timeoutMs: config.sandbox.timeoutMinutes * 60_000,
        onStdout: (chunk) => stdoutSink.write(chunk),
        onStderr: (chunk) => stderrSink.write(chunk),
      }),
      signal,
    );
    stdoutSink.flush();
    stderrSink.flush();
    if (exec.exitCode !== 0) {
      throw new Error(`agent exited with code ${exec.exitCode}`);
    }

    // ---- finalizing ------------------------------------------------------
    await store.setStatus(run.id, "finalizing");
    await sandbox.pullDirectory(sandbox.workspacePath, pulledDir);
    throwIfAborted(signal);

    const artifacts = await collectArtifacts(store, run.id, pulledDir);
    for (const artifact of artifacts) {
      await store.addArtifact(run.id, artifact);
    }

    const result =
      ticket.kind === "spike"
        ? await finalizeSpike({ ticket, pulledDir, artifacts, linear })
        : await finalizeImplementation({ ticket, repo, branch, pulledDir, artifacts, config, linear, log });

    await linear.moveToReview(ticket.id);
    await store.setStatus(run.id, "completed", { finishedAt: new Date().toISOString(), result });
    log("system", `run completed: ${result.prUrl ?? result.commentUrl ?? "done"}`);
  } catch (error) {
    const cancelled = signal.aborted || error instanceof RunCancelledError;
    const message = error instanceof Error ? error.message : String(error);
    const current = store.get(run.id);
    if (current && !["completed", "failed", "cancelled"].includes(current.status)) {
      if (cancelled) {
        await store.setStatus(run.id, "cancelled", { finishedAt: new Date().toISOString() });
        log("system", "run cancelled");
      } else {
        await store.setStatus(run.id, "failed", {
          finishedAt: new Date().toISOString(),
          error: message,
        });
        log("system", `run failed: ${message}`);
      }
    }
  } finally {
    if (sandbox) {
      await sandbox.destroy().catch(() => undefined);
    }
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function branchNameFor(ticket: Ticket): string {
  return `brevi/${ticket.identifier.toLowerCase()}`;
}

/**
 * Credentials forwarded into the sandbox for the coding agent. All keys come
 * from ~/.brevi/config.json (connected via the dashboard); the orchestrator's
 * own environment is never consulted at run time.
 */
function collectAgentEnv(config: BreviConfig): Record<string, string> {
  const env: Record<string, string> = {};
  const { anthropicApiKey, claudeCodeOauthToken, codexApiKey, codexAuthJson } = config.agent;
  if (anthropicApiKey) env.ANTHROPIC_API_KEY = anthropicApiKey;
  if (claudeCodeOauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = claudeCodeOauthToken;
  if (codexApiKey) env.OPENAI_API_KEY = codexApiKey;
  if (Object.keys(env).length === 0 && !codexAuthJson) {
    throw new Error(
      "no agent credentials configured: connect Claude (or Codex) in the dashboard's Connections panel",
    );
  }
  return env;
}

/** In-workspace directory holding a Codex ChatGPT login, wired up via CODEX_HOME. */
const CODEX_HOME_DIR = ".brevi/codex-home";

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new RunCancelledError();
}

async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new RunCancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    // If we lost the race, don't let the abandoned promise become an unhandled rejection.
    promise.catch(() => undefined);
  }
}

/** Buffers chunks and invokes the callback once per complete, non-empty line. */
function lineSink(onLine: (line: string) => void): { write(chunk: string): void; flush(): void } {
  let buffer = "";
  return {
    write(chunk: string): void {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (line.trim()) onLine(line);
        index = buffer.indexOf("\n");
      }
    },
    flush(): void {
      if (buffer.trim()) onLine(buffer);
      buffer = "";
    },
  };
}

/** Run git, scrubbing any embedded token out of error output. */
async function git(args: string[], cwd: string, token: string): Promise<ExecaResult> {
  try {
    return await execa("git", args, { cwd });
  } catch (error) {
    const raw =
      error instanceof Error
        ? ((error as { shortMessage?: string }).shortMessage ?? error.message)
        : String(error);
    const stderr = (error as { stderr?: string }).stderr;
    const detail = [raw, stderr].filter(Boolean).join("\n");
    throw new Error(detail.replaceAll(token, "***"));
  }
}

function classifyArtifact(name: string): ArtifactRef["type"] {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (["png", "jpg", "jpeg"].includes(ext)) return "screenshot";
  if (["webm", "mp4", "gif", "mov"].includes(ext)) return "recording";
  if (["md", "html", "pdf"].includes(ext)) return "document";
  if (["txt", "log"].includes(ext)) return "log";
  return "other";
}

/**
 * Copy the agent's outputs (.brevi/demo/* plus summary/research docs) into the
 * run's artifact directory, flattening nested demo paths into safe names.
 */
async function collectArtifacts(
  store: RunStore,
  runId: string,
  pulledDir: string,
): Promise<ArtifactRef[]> {
  const artifactsDir = store.artifactsDir(runId);
  await mkdir(artifactsDir, { recursive: true });
  const collected: ArtifactRef[] = [];

  const add = async (sourcePath: string, name: string): Promise<void> => {
    const dest = join(artifactsDir, name);
    await copyFile(sourcePath, dest);
    const { size } = await stat(dest);
    collected.push({ name, type: classifyArtifact(name), size });
  };

  const demoDir = join(pulledDir, ".brevi", "demo");
  try {
    const entries = await readdir(demoDir, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const relative = join(entry.parentPath, entry.name).slice(demoDir.length + 1);
      await add(join(demoDir, relative), relative.split(sep).join("__"));
    }
  } catch {
    // no demo directory
  }

  for (const doc of ["summary.md", "research.md"]) {
    const source = join(pulledDir, ".brevi", doc);
    try {
      await stat(source);
    } catch {
      continue;
    }
    await add(source, doc);
  }

  return collected;
}

interface SpikeFinalizeOptions {
  ticket: Ticket;
  pulledDir: string;
  artifacts: ArtifactRef[];
  linear: LinearService;
}

async function finalizeSpike(options: SpikeFinalizeOptions): Promise<RunResult> {
  const { ticket, pulledDir, artifacts, linear } = options;
  let research: string;
  try {
    research = await readFile(join(pulledDir, ".brevi", "research.md"), "utf8");
  } catch {
    throw new Error("agent produced no research output (.brevi/research.md is missing)");
  }

  let body = research.trim();
  if (Buffer.byteLength(body, "utf8") > MAX_COMMENT_BYTES) {
    body = `${truncateUtf8(body, MAX_COMMENT_BYTES)}\n\n---\n*Truncated: the full research is stored with the brevi run's artifacts.*`;
  }
  const comment = `${body}\n\n---\n${BREVI_FOOTER}`;
  const commentUrl = await linear.postComment(ticket.id, comment);

  return {
    kind: "spike",
    commentUrl,
    summary: body,
    artifacts,
  };
}

interface ImplementationFinalizeOptions {
  ticket: Ticket;
  repo: RepoConfig;
  branch: string;
  pulledDir: string;
  artifacts: ArtifactRef[];
  config: BreviConfig;
  linear: LinearService;
  log: (stream: "stdout" | "stderr" | "system", text: string) => void;
}

async function finalizeImplementation(options: ImplementationFinalizeOptions): Promise<RunResult> {
  const { ticket, repo, branch, pulledDir, artifacts, config, linear, log } = options;
  const token = config.github.token;

  const summary = await readFile(join(pulledDir, ".brevi", "summary.md"), "utf8")
    .then((text) => text.trim())
    .catch(() => `Automated change for ${ticket.identifier}: ${ticket.title}`);

  // Agent outputs (summary, demos) live with the run's artifacts, and the
  // mounted Codex login must never leak: nothing under .brevi reaches the branch.
  await rm(join(pulledDir, ".brevi"), { recursive: true, force: true });
  await git(["add", "-A"], pulledDir, token);
  const status = await git(["status", "--porcelain"], pulledDir, token);
  if (!String(status.stdout).trim()) {
    throw new Error("agent made no changes");
  }
  await git(
    ["commit", "-m", `${ticket.identifier}: ${ticket.title}`, "-m", `Automated by brevi for ${ticket.url}`],
    pulledDir,
    token,
  );
  log("system", `pushing branch ${branch}`);
  await git(
    ["push", "--force", authenticatedRemote(repo.remote, token), `HEAD:refs/heads/${branch}`],
    pulledDir,
    token,
  );

  const title = `${ticket.identifier}: ${ticket.title}`;
  const body = buildPrBody({ summary, ticket });
  log("system", "opening pull request");
  const prUrl = await createPullRequest({
    remote: repo.remote,
    head: branch,
    base: repo.defaultBranch,
    title,
    body,
    token,
  });

  let commentUrl: string | undefined;
  try {
    commentUrl = await linear.postComment(
      ticket.id,
      `Opened a pull request for this ticket: ${prUrl}\n\n---\n${BREVI_FOOTER}`,
    );
  } catch (error) {
    log("system", `failed to post Linear comment: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    kind: "implementation",
    prUrl,
    commentUrl,
    branch,
    summary,
    artifacts,
  };
}

/** Demo evidence stays with the local run's artifacts; the PR carries only the summary. */
function buildPrBody(options: { summary: string; ticket: Ticket }): string {
  const { summary, ticket } = options;
  return [summary, `Fixes ${ticket.identifier}`, `---\n${BREVI_FOOTER}`].join("\n\n");
}

/** Truncate a string to at most maxBytes of utf8 without splitting surrogates. */
function truncateUtf8(text: string, maxBytes: number): string {
  let sliced = text;
  while (Buffer.byteLength(sliced, "utf8") > maxBytes) {
    sliced = sliced.slice(0, Math.floor(sliced.length * 0.9));
  }
  return sliced;
}
