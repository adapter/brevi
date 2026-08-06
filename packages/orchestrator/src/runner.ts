import { copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { execa, type Result as ExecaResult } from "execa";
import { BREVI_HOME, WORKSPACES_DIR, type ArtifactRef, type BreviConfig, type LimitInfo, type RepoConfig, type RunResult, type Ticket } from "@brevi/shared";
import type { Sandbox, SandboxProvider } from "@brevi/sandbox";
import { usageCollector } from "./costs.js";
import { authenticatedRemote, createPullRequest, plainRemote } from "./github.js";
import { AgentLimitError, agentProvider, detectLimit, isAgentFailureEvent, resumeTimeFor } from "./limits.js";
import { LinearService } from "./linear.js";
import { buildImplementationPrompt, buildReviewFixPrompt, type RepoMap } from "./prompts.js";
import { uploadRunEvidence, type UploadedEvidence } from "./r2.js";
import { codexReviewEnabled, runCodexReview } from "./review.js";
import { isTerminal, type RunStore } from "./state.js";
import { lineSink, RunCancelledError, throwIfAborted } from "./util.js";

const BREVI_FOOTER = "🤖 Automated by [brevi]";

export { RunCancelledError } from "./util.js";

export interface RunContext {
  runId: string;
  config: BreviConfig;
  store: RunStore;
  provider: SandboxProvider;
  linear: LinearService;
  signal: AbortSignal;
}

/**
 * One attempt of the run pipeline: prepare a checkout + sandbox, run the
 * coding agent, then finalize (push the branch, open the PR). An attempt
 * ended by an agent usage limit parks the run as "waiting" (when
 * auto-restart applies) instead of failing it.
 *
 * Never throws for run failures: every outcome lands in the store as a
 * run status. Only truly unexpected store errors can escape.
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

  const limitProvider = agentProvider(config);
  let detectedLimit: LimitInfo | undefined;
  const noteLimit = (line: string): void => {
    detectedLimit = detectLimit(line, limitProvider) ?? detectedLimit;
  };

  // Assigned once the agent sinks exist; persists an in-flight execution's
  // usage on paths that never reach the post-exec snapshot in runAgent
  // (cancellation, a sandbox that dies mid-exec).
  let recordPendingCost = async (): Promise<void> => {};

  const attempt = await store.beginAttempt(run.id);
  try {
    // ---- preparing -------------------------------------------------------
    await store.setStatus(run.id, "preparing", {
      startedAt: run.startedAt ?? new Date().toISOString(),
      // A retried run sheds the residue of its previous attempt.
      finishedAt: undefined,
      error: undefined,
      resumeAt: undefined,
      limit: undefined,
      result: undefined,
    });
    throwIfAborted(signal);

    const repoKey = ticket.repo;
    const repo = repoKey ? config.repos[repoKey] : undefined;
    if (!repoKey || !repo) {
      throw new Error(`ticket ${ticket.identifier} has no resolved repo mapping`);
    }
    const agentEnv = collectAgentEnv(config);
    // Chromium for playwright demos lives in a shared location so runs never
    // re-download it: baked into the Firecracker rootfs, a persistent host
    // cache for the process provider.
    agentEnv.PLAYWRIGHT_BROWSERS_PATH = await playwrightBrowsersPath(provider.name);
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
    const repoMap = await buildRepoMap(checkoutDir, config.github.token);
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
    try {
      await linear.moveToStarted(ticket.id);
    } catch (error) {
      log("system", `failed to move ${ticket.identifier} to started: ${error instanceof Error ? error.message : String(error)}`);
    }
    throwIfAborted(signal);

    // ---- running ---------------------------------------------------------
    await store.setStatus(run.id, "running");
    const trackThinking = thinkingTracker((phase, durationMs) => {
      store.appendEvent({ runId: run.id, ts: new Date().toISOString(), type: "thinking", phase, durationMs });
    });
    let usage = usageCollector();
    const stdoutSink = lineSink((line) => {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        noteLimit(line);
        log("stdout", line);
        return;
      }
      // Observed before the stream_event/noise filtering below: token_count
      // and result events must reach the collector even though most other
      // event types are dropped from the persisted log.
      usage.observe(event);
      // The Claude stream's init event carries the session id that `claude
      // --resume` needs to reattach later; persisted best-effort so a slow
      // store write never holds up log processing.
      if (isDict(event) && event.type === "system" && event.subtype === "init" && typeof event.session_id === "string") {
        void store.update(run.id, { agentSessionId: event.session_id }).catch(() => undefined);
      }
      if (isDict(event) && event.type === "stream_event") {
        // Subagent streams (parent_tool_use_id set) carry their own thinking
        // block boundaries; only the top-level assistant stream drives the
        // spinner, or one visible thinking spell would log several durations.
        if (!event.parent_tool_use_id) trackThinking(event.event);
        return;
      }
      if (isDict(event) && event.type === "system" && typeof event.subtype === "string" && NOISE_EVENT_SUBTYPES.has(event.subtype)) return;
      if (isAgentFailureEvent(event)) noteLimit(line);
      store.appendEvent({ runId: run.id, ts: new Date().toISOString(), type: "agent", event });
    });
    const stderrSink = lineSink((line) => {
      noteLimit(line);
      log("stderr", line);
    });

    let pendingCostLabel: string | undefined;
    recordPendingCost = async () => {
      if (!pendingCostLabel) return;
      const label = pendingCostLabel;
      pendingCostLabel = undefined;
      stdoutSink.flush();
      stderrSink.flush();
      const provider = agentProvider(config);
      const subscription = provider === "claude" ? !config.agent.anthropicApiKey : !config.agent.codexApiKey;
      const entry = usage.snapshot({ label, provider, subscription });
      if (entry) await store.addCost(run.id, entry);
      usage = usageCollector();
    };

    const activeSandbox = sandbox;
    const runAgent = async (
      prompt: string,
      model: string | undefined,
      effort: string | undefined,
      label: string,
      extraArgs: string[] = [],
    ): Promise<void> => {
      // --include-partial-messages exists only so the stream carries thinking
      // block boundaries; the token-level deltas are reduced to thinking events
      // above and never persisted.
      const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--dangerously-skip-permissions"];
      if (model) args.push("--model", model);
      if (effort) args.push("--effort", effort);
      args.push(...extraArgs, ...config.agent.args);
      log("system", `running ${config.agent.command} (${label}${model ? ` on ${model}` : ""}, timeout ${config.sandbox.timeoutMinutes}m)`);
      // Labeled before the racing await so an abort still knows which
      // execution's usage to persist.
      pendingCostLabel = attempt.number > 1 ? `${label} (attempt ${attempt.number})` : label;
      // The signal terminates the agent subprocess on cancellation and exec
      // resolves once it is gone, so awaiting it (rather than racing past it)
      // guarantees nothing is still running when the sandbox is destroyed.
      const exec = await activeSandbox.exec(config.agent.command, args, {
        cwd: activeSandbox.workspacePath,
        env: codexHome ? { CODEX_HOME: codexHome } : undefined,
        timeoutMs: config.sandbox.timeoutMinutes * 60_000,
        signal,
        onStdout: (chunk) => stdoutSink.write(chunk),
        onStderr: (chunk) => stderrSink.write(chunk),
      });
      // Recorded before the exitCode check so failed, cancelled, and
      // limit-ended executions still keep whatever usage they burned.
      await recordPendingCost();
      throwIfAborted(signal);
      if (exec.exitCode !== 0) {
        if (detectedLimit) throw new AgentLimitError(detectedLimit);
        throw new Error(`agent exited with code ${exec.exitCode} (${label})`);
      }
    };

    // Claude runs put the strong orchestratorModel in the main loop (planning,
    // review) and route the coding labor to an `implementer` subagent on the
    // cheaper implementModel, at the configured orchestratorEffort. An
    // explicit `model` opts out of delegation, and Codex agents keep their
    // plain single-model flow with no effort flag.
    const claude = agentProvider(config) === "claude";
    const mainModel = config.agent.model || (claude ? config.agent.orchestratorModel : undefined);
    const mainEffort = claude ? config.agent.orchestratorEffort : undefined;
    const delegate = claude && !config.agent.model;

    await runAgent(
      buildImplementationPrompt(ticket, repo, config.github.prDescription, { repoMap, delegate }),
      mainModel,
      mainEffort,
      "implementation",
      delegate ? ["--agents", JSON.stringify(implementerAgent(config.agent.implementModel))] : [],
    );

    // Adversarial review is best-effort and grounded only in the ticket plus
    // the actual codebase; confirmed findings feed a fix pass on the main
    // orchestrator model (same runAgent path, so usage limits and cost
    // tracking behave exactly as they do for the implementation pass) before
    // the PR opens.
    if (codexReviewEnabled(config)) {
      const findings = await runCodexReview({
        sandbox: activeSandbox,
        config,
        ticket,
        signal,
        codexHome,
        log,
        addCost: (entry) => store.addCost(run.id, entry),
      });
      if (findings) {
        await runAgent(
          buildReviewFixPrompt({ ticket, findings, delegate }),
          mainModel,
          mainEffort,
          "review fixes",
          delegate ? ["--agents", JSON.stringify(implementerAgent(config.agent.implementModel))] : [],
        );
      }
    } else if (config.agent.codexReview) {
      log(
        "system",
        claude
          ? "codex review skipped: no Codex credential configured"
          : "codex review skipped: the primary agent is already Codex",
      );
    }

    // ---- finalizing ------------------------------------------------------
    await store.setStatus(run.id, "finalizing");
    await sandbox.pullDirectory(sandbox.workspacePath, pulledDir);
    throwIfAborted(signal);

    const artifacts = await collectArtifacts(store, run.id, pulledDir);
    for (const artifact of artifacts) {
      await store.addArtifact(run.id, artifact);
    }

    // Best-effort: uploadRunEvidence never throws, so a wrangler hiccup or a
    // failed upload never fails the run, it just leaves the PR without a
    // demo section.
    const evidence = await uploadRunEvidence({
      runId: run.id,
      artifactsDir: store.artifactsDir(run.id),
      artifacts,
      config,
      log: (text) => log("system", text),
    });

    const result = await finalizeImplementation({ ticket, repo, branch, pulledDir, artifacts, config, linear, log, evidence });

    try {
      if (await linear.moveToReview(ticket.id, signal)) {
        log("system", `moved ${ticket.identifier} to review`);
      }
    } catch (error) {
      if (signal.aborted) throw error;
      log("system", `failed to move ${ticket.identifier} to review: ${error instanceof Error ? error.message : String(error)}`);
    }
    throwIfAborted(signal);
    await store.endAttempt(run.id, { outcome: "completed" });
    await store.setStatus(run.id, "completed", {
      finishedAt: new Date().toISOString(),
      result: { ...result, costTotals: store.get(run.id)?.costTotals },
    });
    log("system", `run completed: ${result.prUrl ?? "done"}`);
  } catch (error) {
    // An execution interrupted mid-flight (cancellation, a sandbox failure)
    // never reached its snapshot in runAgent; keep the spend it burned.
    await recordPendingCost().catch(() => undefined);
    const cancelled = signal.aborted || error instanceof RunCancelledError;
    const message = error instanceof Error ? error.message : String(error);
    const current = store.get(run.id);
    if (current && !isTerminal(current.status)) {
      if (cancelled) {
        await store.endAttempt(run.id, { outcome: "cancelled" });
        await store.setStatus(run.id, "cancelled", { finishedAt: new Date().toISOString() });
        log("system", "run cancelled");
        return;
      }
      // A limit can surface as a thrown AgentLimitError or as a generic
      // failure (e.g. "agent made no changes") after a limit message was seen.
      const limit = error instanceof AgentLimitError ? error.limit : detectedLimit;
      if (!limit) {
        await store.endAttempt(run.id, { outcome: "failed", error: message });
        await store.setStatus(run.id, "failed", {
          finishedAt: new Date().toISOString(),
          error: message,
        });
        log("system", `run failed: ${message}`);
        return;
      }
      await store.endAttempt(run.id, { outcome: "limit", limit });
      if (config.restart.auto && attempt.number < config.restart.maxAttempts) {
        const resumeAt = resumeTimeFor(limit, config).toISOString();
        await store.setStatus(run.id, "waiting", { resumeAt, limit });
        log(
          "system",
          `${limitLabel(limit)}; waiting until ${resumeAt} to start attempt ${attempt.number + 1} of ${config.restart.maxAttempts}`,
        );
      } else {
        const reason = config.restart.auto
          ? `after ${attempt.number} attempts (restart.maxAttempts)`
          : "and auto-restart is off (restart.auto)";
        await store.setStatus(run.id, "failed", {
          finishedAt: new Date().toISOString(),
          error: `${limitLabel(limit)} ${reason}`,
          limit,
        });
        log("system", `run failed: ${limitLabel(limit)} ${reason}`);
      }
    }
  } finally {
    // A run that finished (completed or failed) with retention enabled keeps
    // its sandbox disk around for interactive resume: compute is released,
    // but the disk (and thus tempRoot, which holds it) survives. Every other
    // outcome (cancelled, waiting, no sandbox, retention disabled) tears down
    // the sandbox and its scratch space same as before.
    const finalStatus = store.get(run.id)?.status;
    const retain =
      sandbox !== undefined &&
      config.sandbox.retentionHours > 0 &&
      (finalStatus === "completed" || finalStatus === "failed");
    const current = retain ? store.get(run.id) : undefined;
    if (retain && sandbox && current) {
      try {
        await sandbox.release();
        const retainedUntil = new Date(Date.now() + config.sandbox.retentionHours * 3_600_000).toISOString();
        await store.update(run.id, { sandbox: { ...current.sandbox, retainedUntil } });
        log("system", `sandbox retained until ${retainedUntil}; resume with \`brevi attach ${run.id}\``);
        // Only the host-side scratch goes; the retained disk lives inside
        // tempRoot (rootfs.ext4 for firecracker, workspace/ for process).
        await rm(checkoutDir, { recursive: true, force: true }).catch(() => undefined);
        await rm(pulledDir, { recursive: true, force: true }).catch(() => undefined);
      } catch {
        // release() or the store update failed; fall back to a full teardown
        // rather than leave a half-retained sandbox nobody can reach.
        await sandbox.destroy().catch(() => undefined);
        await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    } else {
      if (sandbox) {
        await sandbox.destroy().catch(() => undefined);
      }
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Human line for logs and failure reasons, e.g. "Claude five-hour limit reached". */
function limitLabel(limit: LimitInfo): string {
  const provider = limit.provider === "claude" ? "Claude" : "Codex";
  const kind = limit.kind === "unknown" ? "usage limit" : `${limit.kind} limit`;
  return `${provider} ${kind} reached`;
}

function branchNameFor(ticket: Ticket): string {
  return `brevi/${ticket.identifier.toLowerCase()}`;
}

/**
 * Definition for the Claude Code `--agents` flag: the subagent the
 * orchestrating model dispatches implementation tasks to.
 */
function implementerAgent(model: string): Record<string, { description: string; prompt: string; model: string }> {
  return {
    implementer: {
      description: "Implements one well-scoped coding task in this checkout exactly as instructed",
      model,
      prompt: [
        "You are an implementation agent working in a git checkout. Execute exactly the task you were given: follow the repository's existing conventions, run the verification you were asked to run, and report concisely what you changed and what you observed.",
        "Leave all changes uncommitted; never run `git commit` or `git push`.",
        "Never use em dashes (\u2014) or spaced hyphens standing in for them in anything you write; use a comma, colon, or parentheses instead.",
      ].join("\n"),
    },
  };
}

/** Where the Firecracker rootfs bakes Playwright browsers (see build-rootfs.sh). */
const FIRECRACKER_BROWSERS_PATH = "/opt/ms-playwright";

/**
 * Shared Playwright browser location, so runs never re-download Chromium. The
 * process provider gets a persistent host cache under ~/.brevi; the first run
 * to need a browser installs into it and every later run reuses it.
 */
export async function playwrightBrowsersPath(provider: string): Promise<string> {
  if (provider === "firecracker") return FIRECRACKER_BROWSERS_PATH;
  const dir = join(BREVI_HOME, "cache", "ms-playwright");
  await mkdir(dir, { recursive: true });
  return dir;
}

const REPO_MAP_MAX_FILES = 400;

/**
 * Cheap orientation injected into every prompt: the tracked file list plus
 * recent history, generated from the checkout so it is never stale. Failure
 * only costs the agent some exploration turns, so it never fails the run.
 */
async function buildRepoMap(checkoutDir: string, token: string): Promise<RepoMap | undefined> {
  try {
    const files = await git(["ls-files"], checkoutDir, token);
    const log = await git(["log", "--oneline", "-n", "10"], checkoutDir, token);
    const lines = String(files.stdout).split("\n").filter(Boolean);
    const tree = lines.slice(0, REPO_MAP_MAX_FILES);
    if (lines.length > REPO_MAP_MAX_FILES) {
      tree.push(`... plus ${lines.length - REPO_MAP_MAX_FILES} more files (run \`git ls-files\` for the rest)`);
    }
    return { tree: tree.join("\n"), commits: String(log.stdout).trim() };
  } catch {
    return undefined;
  }
}

/**
 * Credentials forwarded into the sandbox for the coding agent. All keys come
 * from ~/.brevi/config.json (connected via the dashboard); the orchestrator's
 * own environment is never consulted at run time.
 */
export function collectAgentEnv(config: BreviConfig): Record<string, string> {
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

const isDict = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * System-event subtypes with no replay value: newer Claude Code versions emit
 * these as {type: "system", subtype: ...} status lines and per-token progress
 * ticks that would bloat events.jsonl and spam the console if persisted.
 */
const NOISE_EVENT_SUBTYPES = new Set(["status", "thinking_tokens"]);

/**
 * Reduces the agent's raw partial-message stream events to thinking-block
 * boundaries: "started" when a (redacted) thinking block opens, "finished"
 * with the elapsed time when it closes. Everything else is ignored.
 */
function thinkingTracker(
  emit: (phase: "started" | "finished", durationMs?: number) => void,
): (rawEvent: unknown) => void {
  const startedAt = new Map<number, number>();
  return (rawEvent: unknown): void => {
    if (!isDict(rawEvent)) return;
    const index = typeof rawEvent.index === "number" ? rawEvent.index : undefined;
    if (rawEvent.type === "message_start") {
      startedAt.clear();
    } else if (rawEvent.type === "content_block_start" && index !== undefined) {
      const block = rawEvent.content_block;
      const kind = isDict(block) ? block.type : undefined;
      if ((kind === "thinking" || kind === "redacted_thinking") && !startedAt.has(index)) {
        startedAt.set(index, Date.now());
        emit("started");
      }
    } else if (rawEvent.type === "content_block_stop" && index !== undefined) {
      const began = startedAt.get(index);
      if (began !== undefined) {
        startedAt.delete(index);
        emit("finished", Date.now() - began);
      }
    }
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
 * Copy the agent's outputs (.brevi/demo/* plus summary/review docs) into the
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

  for (const doc of ["summary.md", "review.md"]) {
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

interface ImplementationFinalizeOptions {
  ticket: Ticket;
  repo: RepoConfig;
  branch: string;
  pulledDir: string;
  artifacts: ArtifactRef[];
  config: BreviConfig;
  linear: LinearService;
  log: (stream: "stdout" | "stderr" | "system", text: string) => void;
  evidence: UploadedEvidence[];
}

async function finalizeImplementation(options: ImplementationFinalizeOptions): Promise<RunResult> {
  const { ticket, repo, branch, pulledDir, artifacts, config, linear, log, evidence } = options;
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
  const body = buildPrBody({ summary, ticket, evidence });
  log("system", "opening pull request");
  const prUrl = await createPullRequest({
    remote: repo.remote,
    head: branch,
    base: repo.defaultBranch,
    title,
    body,
    token,
  });

  try {
    await linear.postComment(
      ticket.id,
      `Opened a pull request for this ticket: ${prUrl}\n\n---\n${BREVI_FOOTER}`,
    );
  } catch (error) {
    log("system", `failed to post Linear comment: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    prUrl,
    branch,
    summary,
    artifacts,
  };
}

/**
 * When R2 evidence upload succeeded, the PR gets a "## Demo" section between
 * the summary and the "Fixes ..." line: images embed directly, videos with a
 * GIF preview become a clickable thumbnail linking to the full recording,
 * and videos without one fall back to a plain link. Otherwise (no evidence
 * uploaded, R2 unconfigured) demo evidence stays with the local run's
 * artifacts and the PR carries only the summary.
 */
export function buildPrBody(options: { summary: string; ticket: Ticket; evidence: UploadedEvidence[] }): string {
  const { summary, ticket, evidence } = options;
  const parts = [summary];
  if (evidence.length > 0) {
    const items = evidence.map((item) => {
      if (item.kind === "image") return `![${item.name}](${item.url})`;
      if (item.previewUrl) return `[![${item.name}](${item.previewUrl})](${item.url})`;
      return `[${item.name}](${item.url})`;
    });
    parts.push(["## Demo", ...items].join("\n\n"));
  }
  parts.push(`Fixes ${ticket.identifier}`, `---\n${BREVI_FOOTER}`);
  return parts.join("\n\n");
}

