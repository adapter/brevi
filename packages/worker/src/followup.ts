import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { WORKSPACES_DIR } from "@brevi/shared";
import type { Sandbox } from "@brevi/sandbox";
import {
  AgentLimitError,
  agentProvider,
  authenticatedRemote,
  FALLBACK_COMMIT_IDENTITY,
  formatPrFeedback,
  gatherPrFeedback,
  hasActionableFeedback,
  isContainedRegularFile,
  isTerminal,
  memoryKeyFor,
  parsePrUrl,
  plainRemote,
  postPrComment,
  readRunMemories,
  resolveCommitIdentity,
  RunCancelledError,
  throwIfAborted,
  type PrFeedback,
} from "@brevi/orchestrator/internal";
import { resolveCcusageCommand } from "./ccusage.js";
import { buildFollowUpPrompt } from "./prompts.js";
import { provisionCredentials } from "./provision.js";
import {
  agentModelPlan,
  BREVI_FOOTER,
  collectAgentEnv,
  createAgentSession,
  finishRunSandbox,
  git,
  implementerAgent,
  limitLabel,
  playwrightBrowsersPath,
  type AgentSession,
  type RunContext,
} from "./runner.js";

/** Rebase outcome carried into the follow-up prompt and the finalizing gate. */
type RebaseResult = { status: "clean" } | { status: "conflicted"; detail: string };

/**
 * One follow-up execution on an already-completed run: gather PR feedback,
 * rebase the PR branch onto its base inside the sandbox (reusing the
 * retained disk when possible), let the agent resolve conflicts and address
 * feedback, push with force-with-lease, and post one summary comment. Never
 * touches the Linear ticket, and never parks as "waiting": a usage limit
 * fails the follow-up.
 *
 * Never throws for run failures: every outcome lands in the store as a run
 * status. Only truly unexpected store errors can escape.
 */
export async function executeFollowUp(ctx: RunContext): Promise<void> {
  // Follow-ups leave the ticket's Linear state alone and run even while
  // Linear is disconnected; `linear` from the context is unused here.
  const { config, store, recalledMemories, recordMemories, prompts, provider, signal } = ctx;
  const run = store.get(ctx.runId);
  if (!run) throw new Error(`unknown run ${ctx.runId}`);
  const ticket = run.ticket;
  const result = run.result;
  const prUrl = result?.prUrl;

  const tempRoot = join(WORKSPACES_DIR, run.id);
  const checkoutDir = join(tempRoot, "checkout");
  const pulledDir = join(tempRoot, "out");
  let sandbox: Sandbox | undefined;
  let session: AgentSession | undefined;

  const log = (stream: "stdout" | "stderr" | "system", text: string): void => {
    store.appendEvent({ runId: run.id, ts: new Date().toISOString(), type: "log", stream, text });
  };

  const prParts = prUrl ? parsePrUrl(prUrl) : null;
  if (!prUrl || !result || !prParts) {
    // Validated at the API layer (Orchestrator#followUpRun); reaching here
    // means something else raced the run's result away. Fail cleanly rather
    // than throw, matching executeRun's never-throw contract.
    await store.setStatus(run.id, "failed", {
      finishedAt: new Date().toISOString(),
      error: "run has no pull request to follow up on",
    });
    log("system", "follow-up failed: run has no pull request to follow up on");
    return;
  }
  // "owner/name" the PR belongs to, straight from its URL: the checkout and
  // push target derive from the PR itself, never from the mutable repo
  // mapping, which can be removed or repointed after the original run.
  const prRepo = `${prParts.owner}/${prParts.name}`;
  // Memories are keyed by the repository the PR belongs to, the same identity
  // the checkout and push target derive from, so a follow-up still recalls the
  // right facts after the run's repo mapping was repointed or removed.
  const memoryKey = memoryKeyFor(prRepo);
  // Cutoff for "comments since the last push". pushedAt is recorded on every
  // brevi push; runs persisted before it existed fall back to the completion
  // time, which lands seconds after the original push.
  const commentsSince = result.pushedAt ?? run.finishedAt;

  await store.beginAttempt(run.id, "follow-up");
  try {
    // ---- preparing -------------------------------------------------------
    await store.setStatus(run.id, "preparing", {
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      error: undefined,
      limit: undefined,
      resumeAt: undefined,
      // result is deliberately kept, unlike a retry: the follow-up belongs
      // to the same delivered PR.
    });
    throwIfAborted(signal);

    const token = config.github.token;

    log("system", `gathering feedback from ${prUrl}`);
    const feedback = await gatherPrFeedback({ prUrl, token, commentsSince });
    if (feedback.state !== "open") {
      throw new Error(`the pull request is ${feedback.state}; nothing to follow up on`);
    }
    if (feedback.headRepo !== prRepo) {
      throw new Error(
        `the pull request's head branch lives in ${feedback.headRepo ?? "an unknown repository"}, not ${prRepo}; follow-ups only push branches owned by the pull request's repository`,
      );
    }
    // The live head branch, not the stored result: the branch is whatever
    // the open PR says it is today.
    const branch = feedback.headBranch;
    const base = feedback.baseBranch;
    log("system", feedbackSummaryLine(feedback));
    throwIfAborted(signal);

    const agentEnv = collectAgentEnv(config);
    agentEnv.PLAYWRIGHT_BROWSERS_PATH = await playwrightBrowsersPath(provider.name);

    const prepareCheckout = async (): Promise<void> => {
      await rm(checkoutDir, { recursive: true, force: true });
      await mkdir(tempRoot, { recursive: true });
      log("system", `cloning ${prRepo} for the follow-up`);
      // Cloned straight from the PR's own repository. A full clone, not the
      // depth-50 shallow clone executeRun uses: the rebase needs a real
      // merge base with the PR branch, which a shallow clone can miss
      // entirely.
      await git(["clone", "--branch", base, authenticatedRemote(prRepo, token), checkoutDir], tempRoot, token);
      await git(
        ["fetch", authenticatedRemote(prRepo, token), `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
        checkoutDir,
        token,
      );
      await git(["checkout", "-B", branch, `refs/remotes/origin/${branch}`], checkoutDir, token);
      // Credentials never enter the sandbox.
      await git(["remote", "set-url", "origin", plainRemote(prRepo)], checkoutDir, token);
      const identity =
        (await resolveCommitIdentity(token, (message) => log("system", message))) ?? FALLBACK_COMMIT_IDENTITY;
      await git(["config", "user.name", identity.name], checkoutDir, token);
      await git(["config", "user.email", identity.email], checkoutDir, token);
      // The follow-up agent commits inside the sandbox, and .brevi/
      // (scaffolding, possibly a mounted Codex login) must be invisible even
      // to `git add -A`.
      await appendFile(join(checkoutDir, ".git", "info", "exclude"), ".brevi/\n");
    };

    const syncRehydrated = async (target: Sandbox): Promise<void> => {
      // The retained workspace still holds the original run's uncommitted
      // tree and knows nothing about the pushed PR branch; replacing its
      // .git with the fresh host clone's and hard-resetting brings it to the
      // PR head while keeping untracked build state (node_modules) in place.
      const rmGit = await target.exec("rm", ["-rf", `${target.workspacePath}/.git`]);
      if (rmGit.exitCode !== 0) throw new Error(`failed to clear the rehydrated sandbox's .git: ${rmGit.stderr}`);
      await target.pushDirectory(join(checkoutDir, ".git"), `${target.workspacePath}/.git`);
      const cwd = target.workspacePath;
      // Best-effort: an in-progress rebase from a previous session may or may not exist.
      await target.exec("git", ["rebase", "--abort"], { cwd, signal });
      const checkout = await target.exec("git", ["checkout", "-f", "-B", branch, `refs/remotes/origin/${branch}`], {
        cwd,
        signal,
      });
      if (checkout.exitCode !== 0) throw new Error(`failed to check out ${branch} in the rehydrated sandbox: ${checkout.stderr}`);
      const reset = await target.exec("git", ["reset", "--hard", `refs/remotes/origin/${branch}`], { cwd, signal });
      if (reset.exitCode !== 0) throw new Error(`failed to reset the rehydrated sandbox to ${branch}: ${reset.stderr}`);
      const rmBrevi = await target.exec("rm", ["-rf", ".brevi"], { cwd, signal });
      if (rmBrevi.exitCode !== 0) throw new Error(`failed to clear .brevi in the rehydrated sandbox: ${rmBrevi.stderr}`);
    };

    // Reuse the retained disk when it is still within its window and
    // belongs to the active provider; otherwise fall back to a fresh boot
    // from a new checkout of the PR branch.
    const retainedUntil = run.sandbox.retainedUntil;
    const rehydratable =
      retainedUntil !== undefined &&
      Date.parse(retainedUntil) > Date.now() &&
      (run.sandbox.provider === undefined || run.sandbox.provider === provider.name);
    if (rehydratable) {
      try {
        sandbox = await provider.rehydrate({ id: run.id, env: agentEnv });
        log("system", "rehydrated the run's retained sandbox");
      } catch (error) {
        log(
          "system",
          `could not rehydrate the retained sandbox (falling back to a fresh one): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (!sandbox) {
      // A stale retained disk (expired, wrong provider, failed boot) must go
      // before create() reuses the same id and paths.
      if (run.sandbox.retainedUntil) {
        await provider.discard(run.id).catch(() => undefined);
        await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
        // The wire's sandbox patch is a merge, not a replacement: naming just
        // retainedUntil (rather than spreading run.sandbox into the patch)
        // reports only what actually changed, leaving provider/id on the
        // host exactly as they are. RunReporter translates this explicit
        // `undefined` into the wire's `null` when it builds the patch (see
        // toRunPatch), the same way every other field's clear does.
        await store.update(run.id, { sandbox: { retainedUntil: undefined } });
      }
    }
    await prepareCheckout();
    throwIfAborted(signal);
    if (sandbox) {
      try {
        await syncRehydrated(sandbox);
      } catch (error) {
        log(
          "system",
          `could not sync the rehydrated sandbox (falling back to a fresh one): ${error instanceof Error ? error.message : String(error)}`,
        );
        await sandbox.destroy().catch(() => undefined);
        sandbox = undefined;
        // Nothing exists now: retract both the id and the retention, so a
        // read landing between here and the fresh sandbox a few lines below
        // never points at a disk that was just destroyed. Naming a field
        // with an explicit `undefined` is how a sandbox patch clears it (see
        // RunReporter's toRunPatch, which turns that into the wire's null).
        await store.update(run.id, { sandbox: { id: undefined, retainedUntil: undefined } });
        // destroy() may have taken tempRoot (the workspace root IS tempRoot),
        // so the checkout has to be redone.
        await prepareCheckout();
      }
    }
    if (!sandbox) {
      log("system", `creating ${provider.name} sandbox`);
      sandbox = await provider.create({ id: run.id, env: agentEnv });
      await sandbox.pushDirectory(checkoutDir, sandbox.workspacePath);
    }
    await store.update(run.id, { sandbox: { provider: provider.name, id: sandbox.id } });

    // Credentials are installed as sandbox-wide state (a shell profile plus
    // the Codex/Grok auth.json files at stable CODEX_HOME / GROK_HOME,
    // outside the workspace so the follow-up's tree stays clean),
    // reinstalled fresh so a rehydrated retained sandbox picks up rotated
    // credentials too. No githubToken: runs never hold push credentials.
    const { codexHome, grokHome } = await provisionCredentials({
      sandbox,
      runId: run.id,
      env: agentEnv,
      codexAuthJson: config.agent.codexAuthJson || undefined,
      grokAuthJson: config.agent.grokAuthJson || undefined,
    });
    const claude = agentProvider(config) === "claude";
    const ccusageCommand = claude ? await resolveCcusageCommand(sandbox, provider.name, signal) : undefined;
    if (claude && !ccusageCommand) {
      log("system", "ccusage not available in the sandbox; live cost sampling disabled");
    }
    throwIfAborted(signal);

    // Cost entries for follow-ups are labeled "follow-up", numbered from the
    // second one on so repeated clicks stay distinguishable.
    const followUpNumber = (store.get(run.id)?.attempts ?? []).filter((a) => a.kind === "follow-up").length;
    session = createAgentSession({
      runId: run.id,
      store,
      config,
      sandbox,
      signal,
      codexHome,
      grokHome,
      ccusageCommand,
      labelFor: (label) => (followUpNumber > 1 ? `${label} ${followUpNumber}` : label),
      reportUsageSnapshot: ctx.reportUsageSnapshot,
    });

    // ---- rebase (still preparing) -----------------------------------------
    const rebase = await performRebase({ sandbox, base, branch, signal, log });
    throwIfAborted(signal);

    // ---- running (only when there is something for the agent to do) ------
    const actionable = hasActionableFeedback(feedback);
    const needAgent = actionable || rebase.status === "conflicted";
    if (needAgent) {
      await store.setStatus(run.id, "running");
      const { mainModel, mainEffort, delegate } = agentModelPlan(config);
      const recalled = config.memory.enabled ? recalledMemories : [];
      if (recalled.length > 0) log("system", `recalled ${recalled.length} memories for ${memoryKey}`);
      await session.runAgent(
        buildFollowUpPrompt({
          ticket,
          prUrl,
          branch,
          baseBranch: base,
          // The full gathered bundle, verbatim: even a conflict-only session
          // needs the PR's mergeability and CI state.
          feedback: formatPrFeedback(feedback),
          rebase,
          delegate,
          memories: recalled,
          recordMemories: prompts.recordMemories,
        }),
        mainModel,
        mainEffort,
        "follow-up",
        delegate ? { agents: implementerAgent(config.agent.implementModel) } : undefined,
      );
    } else {
      log("system", "no unaddressed feedback and the rebase was clean; skipping the agent session");
    }

    // ---- finalizing --------------------------------------------------------
    await store.setStatus(run.id, "finalizing");
    await rm(pulledDir, { recursive: true, force: true }).catch(() => undefined);
    await sandbox.pullDirectory(sandbox.workspacePath, pulledDir);
    throwIfAborted(signal);
    // An unfinished rebase must never be pushed.
    if (existsSync(join(pulledDir, ".git", "rebase-merge")) || existsSync(join(pulledDir, ".git", "rebase-apply"))) {
      throw new Error("the rebase was not completed; leaving the pull request untouched");
    }
    // The reply is read before .brevi is scrubbed: nothing under .brevi may
    // reach the branch.
    const replyPath = join(pulledDir, ".brevi", "reply.md");
    const reply = (await isContainedRegularFile(pulledDir, replyPath))
      ? await readFile(replyPath, "utf8")
          .then((text) => text.trim())
          .catch(() => "")
      : "";
    // Read alongside the reply, before .brevi is scrubbed: a follow-up
    // explores the repo too, and what it learned outlives this sandbox. Only
    // when an agent actually ran, so a memories.md that was already in the
    // checkout is never mistaken for something this session learned. The
    // host owns the memory store; this only hands the raw candidates back.
    if (needAgent && config.memory.enabled) {
      const learned = await readRunMemories(pulledDir);
      if (learned.length > 0) await recordMemories(memoryKey, learned);
    }
    await rm(join(pulledDir, ".brevi"), { recursive: true, force: true });
    await git(["add", "-A"], pulledDir, token);
    const status = await git(["status", "--porcelain"], pulledDir, token);
    if (String(status.stdout).trim()) {
      // Backstop for an agent that edited but forgot to commit.
      await git(["commit", "-m", `${ticket.identifier}: address review feedback`], pulledDir, token);
    }
    const head = String((await git(["rev-parse", "HEAD"], pulledDir, token)).stdout).trim();
    const headChanged = head !== feedback.headSha;
    if (!headChanged) {
      log("system", "branch already matches the pull request head; nothing to push");
    } else {
      // A cancel clicked during finalization must win before the branch is
      // touched; the abortable push closes the remaining window.
      throwIfAborted(signal);
      log("system", `pushing ${branch} (force-with-lease)`);
      // The lease pins the exact head observed at gather time, so a human
      // push that lands mid-follow-up is never overwritten.
      await git(
        [
          "push",
          `--force-with-lease=refs/heads/${branch}:${feedback.headSha}`,
          authenticatedRemote(prRepo, token),
          `HEAD:refs/heads/${branch}`,
        ],
        pulledDir,
        token,
        signal,
      );
      // Recorded immediately after the push (not at completion), so the next
      // follow-up's comment cutoff survives even if this one fails later.
      await store.update(run.id, {
        result: { ...(store.get(run.id)?.result ?? result), pushedAt: new Date().toISOString() },
      });
    }
    // The summary comment is part of the follow-up's contract: every push
    // gets one (a drift-only rebase included), and gathered feedback gets
    // one even when the agent concluded no code change was needed. Only a
    // no-op (branch already current, nothing to address) posts nothing.
    // Reviewers' threads are deliberately left unresolved; resolving them is
    // the reviewer's call.
    if (headChanged || actionable) {
      // Last signal check before the other remote side effect; a push that
      // already landed stays (pushedAt above already recorded it).
      throwIfAborted(signal);
      const summary =
        reply || (await fallbackReply({ feedback, base, headChanged, actionable, pulledDir, token }));
      await postFollowUpComment({ prUrl, token, body: `${summary}\n\n---\n${BREVI_FOOTER}`, log });
      log("system", "posted the follow-up summary comment");
    }
    throwIfAborted(signal);
    await store.endAttempt(run.id, { outcome: "completed" });
    await store.setStatus(run.id, "completed", {
      finishedAt: new Date().toISOString(),
      result: { ...(store.get(run.id)?.result ?? result), costTotals: store.get(run.id)?.costTotals },
    });
    log("system", `follow-up completed: ${prUrl}`);
  } catch (error) {
    // An execution interrupted mid-flight never reached its snapshot in
    // runAgent; keep the spend it burned.
    await session?.recordPendingCost().catch(() => undefined);
    const cancelled = signal.aborted || error instanceof RunCancelledError;
    const message = error instanceof Error ? error.message : String(error);
    const current = store.get(run.id);
    if (current && !isTerminal(current.status)) {
      if (cancelled) {
        await store.endAttempt(run.id, { outcome: "cancelled" });
        await store.setStatus(run.id, "cancelled", { finishedAt: new Date().toISOString() });
        log("system", "follow-up cancelled");
        return;
      }
      // Unlike executeRun, a usage limit fails the follow-up outright: the
      // auto-restart path re-queues through the implementation pipeline,
      // which would redo the whole ticket instead of the follow-up.
      const limit = error instanceof AgentLimitError ? error.limit : session?.detectedLimit();
      if (limit) {
        await store.endAttempt(run.id, { outcome: "limit", limit });
        await store.setStatus(run.id, "failed", {
          finishedAt: new Date().toISOString(),
          error: `${limitLabel(limit)} during the follow-up`,
          limit,
        });
        log("system", `follow-up failed: ${limitLabel(limit)}`);
      } else {
        await store.endAttempt(run.id, { outcome: "failed", error: message });
        await store.setStatus(run.id, "failed", { finishedAt: new Date().toISOString(), error: message });
        log("system", `follow-up failed: ${message}`);
      }
    }
  } finally {
    if (sandbox) {
      await finishRunSandbox({ sandbox, config, store, runId: run.id, tempRoot, checkoutDir, pulledDir, log });
    } else if (store.get(run.id)?.sandbox.retainedUntil) {
      // Failed before the retained disk was ever booted or discarded (e.g.
      // gathering feedback threw): the disk and its retention claim stay
      // valid, so only this follow-up's scratch may go; tempRoot holds the
      // disk and must survive.
      await rm(checkoutDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(pulledDir, { recursive: true, force: true }).catch(() => undefined);
    } else {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/**
 * Post the summary comment, retrying transient GitHub failures. Exhausting
 * the retries throws: a follow-up that cannot deliver its summary fails
 * loudly instead of completing without the comment it promised.
 */
async function postFollowUpComment(options: {
  prUrl: string;
  token: string;
  body: string;
  log: (stream: "stdout" | "stderr" | "system", text: string) => void;
}): Promise<void> {
  const delays = [2_000, 5_000];
  for (let attempt = 0; ; attempt += 1) {
    try {
      await postPrComment({ prUrl: options.prUrl, token: options.token, body: options.body });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const delay = delays[attempt];
      if (delay === undefined) {
        throw new Error(
          `failed to post the follow-up summary comment: ${message}. Any push this follow-up made already landed on the branch.`,
        );
      }
      options.log("system", `posting the follow-up comment failed (retrying): ${message}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Summary comment built when the agent left no .brevi/reply.md (or never
 * ran, for a drift-only rebase): a complete mapping of every gathered
 * feedback item to what happened to it, plus the commit subjects this
 * follow-up added when they can be derived.
 */
async function fallbackReply(options: {
  feedback: PrFeedback;
  base: string;
  headChanged: boolean;
  actionable: boolean;
  pulledDir: string;
  token: string;
}): Promise<string> {
  const { feedback, base, headChanged, actionable, pulledDir, token } = options;
  const lines: string[] = [
    headChanged
      ? `Rebased onto \`${base}\` and pushed.`
      : "Reviewed the feedback; no code changes were needed.",
  ];
  if (headChanged) {
    const subjects = await newCommitSubjects({ pulledDir, base, headSha: feedback.headSha, token });
    if (subjects.length > 0) {
      lines.push("", "Commits added by this follow-up:", ...subjects.map((subject) => `- ${subject}`));
    }
  }
  if (actionable) {
    lines.push(
      "",
      headChanged
        ? "The agent session left no per-item reply; each item below was processed against the commits in this push:"
        : "The agent session left no per-item reply; each item below was reviewed without a code change:",
    );
    for (const thread of feedback.threads) {
      const location = thread.line !== undefined ? `${thread.path}:${thread.line}` : thread.path;
      const authors = [...new Set(thread.comments.map((comment) => comment.author))]
        .map((author) => `@${author}`)
        .join(", ");
      lines.push(`- review thread at \`${location}\`${authors ? ` (${authors})` : ""}`);
    }
    for (const review of feedback.reviews) {
      lines.push(`- review by @${review.author} (${review.state.toLowerCase().replaceAll("_", " ")})`);
    }
    for (const comment of feedback.comments) {
      lines.push(`- comment by @${comment.author} (${comment.createdAt})`);
    }
  }
  return lines.join("\n");
}

/**
 * Subjects of the commits this follow-up added: reachable from the rebased
 * HEAD but not, by subject, part of the PR's previous head. Best-effort; any
 * git error yields an empty list rather than blocking the comment.
 */
async function newCommitSubjects(options: {
  pulledDir: string;
  base: string;
  headSha: string;
  token: string;
}): Promise<string[]> {
  const { pulledDir, base, headSha, token } = options;
  const subjects = (raw: unknown): string[] =>
    String(raw)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  try {
    const previous = await git(["log", "--format=%s", headSha, "--not", `refs/remotes/origin/${base}`], pulledDir, token);
    const current = await git(["log", "--format=%s", "HEAD", "--not", `refs/remotes/origin/${base}`], pulledDir, token);
    const seen = new Set(subjects(previous.stdout));
    return subjects(current.stdout).filter((subject) => !seen.has(subject));
  } catch {
    return [];
  }
}

/** One-line summary of the gathered feedback for the run's log. */
function feedbackSummaryLine(feedback: PrFeedback): string {
  const parts = [
    `${feedback.threads.length} unresolved thread${feedback.threads.length === 1 ? "" : "s"}`,
    `${feedback.reviews.length} review summar${feedback.reviews.length === 1 ? "y" : "ies"}`,
    `${feedback.comments.length} comment${feedback.comments.length === 1 ? "" : "s"} since the last push`,
    `mergeable: ${feedback.mergeableState ?? "unknown"}`,
  ];
  return `feedback: ${parts.join(", ")}`;
}

/**
 * Rebase the PR branch onto its base inside the sandbox. A clean rebase
 * returns immediately; a conflicted one is intentionally left in place (not
 * aborted) for the agent to resolve. A rebase that fails for any other
 * reason (no merge base, dirty tree) is aborted and thrown as an error.
 */
async function performRebase(options: {
  sandbox: Sandbox;
  base: string;
  branch: string;
  signal: AbortSignal;
  log: (stream: "stdout" | "stderr" | "system", text: string) => void;
}): Promise<RebaseResult> {
  const { sandbox, base, branch, signal, log } = options;
  const cwd = sandbox.workspacePath;
  const rebase = await sandbox.exec("git", ["rebase", `refs/remotes/origin/${base}`], {
    cwd,
    signal,
    env: { GIT_EDITOR: "true" },
  });
  if (rebase.exitCode === 0) {
    log("system", `rebased ${branch} onto origin/${base} cleanly`);
    return { status: "clean" };
  }
  const conflicted = await sandbox.exec("git", ["diff", "--name-only", "--diff-filter=U"], { cwd, signal });
  const conflictedFiles = String(conflicted.stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (conflictedFiles.length > 0) {
    log("system", `rebase onto origin/${base} stopped on ${conflictedFiles.length} conflicted file(s)`);
    const diff = await sandbox.exec("git", ["diff"], { cwd, signal });
    const diffLimit = 20000;
    const diffText =
      diff.stdout.length > diffLimit ? `${diff.stdout.slice(0, diffLimit)}\n... (truncated)` : diff.stdout;
    const detail = `Conflicted files:\n${conflictedFiles.join("\n")}\n\n${diffText}`;
    // The conflicted rebase state is intentionally left in place for the agent.
    return { status: "conflicted", detail };
  }
  await sandbox.exec("git", ["rebase", "--abort"], { cwd, signal }).catch(() => undefined);
  const tail = `${rebase.stderr}\n${rebase.stdout}`.trim().slice(-2000);
  throw new Error(`rebase onto ${base} failed: ${tail}`);
}
