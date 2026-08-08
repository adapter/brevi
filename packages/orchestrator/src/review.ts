/**
 * Adversarial Codex review, run after the coding agent's implementation pass
 * and before a run finalizes. Three independent reviewers judge the
 * uncommitted diff from different angles, a synthesis pass verifies and
 * ranks what they found, and confirmed findings feed a fix pass back in
 * runner.ts. Best-effort throughout: a review failure never fails the run,
 * it just skips straight to finalizing without a fix pass.
 */

import type { Sandbox } from "@brevi/sandbox";
import type { BreviConfig, CostEntry, Ticket } from "@brevi/shared";
import { ccusageCostEntry, readCodexSessionUsage } from "./ccusage.js";
import { usageCollector } from "./costs.js";
import { agentProvider } from "./limits.js";
import { buildReviewerPrompt, buildReviewSynthesisPrompt, type ReviewAngle } from "./prompts.js";
import { lineSink, RunCancelledError, throwIfAborted } from "./util.js";

/**
 * True when the review is on in config, the primary agent is Claude (the
 * review is an independent cross-check by a different provider; a Codex
 * primary agent reviewing itself would only multiply Codex spend), and a
 * Codex credential is actually available to run it with.
 */
export function codexReviewEnabled(config: BreviConfig): boolean {
  return (
    config.agent.codexReview &&
    agentProvider(config) === "claude" &&
    (config.agent.codexApiKey !== "" || config.agent.codexAuthJson !== "")
  );
}

const REVIEW_ANGLES: ReviewAngle[] = [
  {
    key: "requirements",
    title: "requirements coverage",
    instruction:
      "Requirements coverage: compare the implementation against everything the ticket asks for, including acceptance criteria. Hunt for requirements that are missing, half-done, or implemented differently than specified.",
  },
  {
    key: "bugs",
    title: "bug hunt",
    instruction:
      "Bug hunt: read the diff line by line hunting for real defects: logic errors, broken edge cases, unhandled failures, type confusion, races, and anything that would crash or misbehave at runtime.",
  },
  {
    key: "regressions",
    title: "regression risk",
    instruction:
      "Regression risk: for every function, type, or config field the diff touches, inspect its call sites and consumers across the repository. Hunt for breakage outside the diff: callers not updated, changed behavior other code relies on, stale docs or schemas.",
  },
];

const REVIEW_DIR = ".brevi/review";
const REVIEW_FILE = ".brevi/review.md";
const NO_FINDINGS_MARKER = "No confirmed findings.";

/** Console log truncation for the confirmed-findings dump: enough to be useful without flooding the console. */
const REVIEW_LOG_MAX_CHARS = 4000;

export interface CodexReviewOptions {
  sandbox: Sandbox;
  config: BreviConfig;
  ticket: Ticket;
  signal: AbortSignal;
  codexHome?: string;
  /** The resolved ccusage binary, when live sampling was set up for the run's Claude executions; reused here for a one-shot post-exec read. */
  ccusageCommand?: string;
  log: (stream: "stdout" | "stderr" | "system", text: string) => void;
  addCost: (entry: CostEntry) => Promise<void>;
}

/**
 * Runs the three independent reviewers in parallel, then a synthesis pass
 * that verifies and ranks what they found. Returns the confirmed-findings
 * markdown when the review confirmed something worth fixing, undefined when
 * there was nothing to fix or the review could not complete.
 *
 * Never throws for review failures, only cancellation escapes (via
 * throwIfAborted raising RunCancelledError). Cancellation reaches every Codex
 * subprocess through the exec signal, and each exec is awaited after it, so by
 * the time the error escapes no reviewer process is left running.
 */
export async function runCodexReview(options: CodexReviewOptions): Promise<string | undefined> {
  const { sandbox, config, ticket, signal, codexHome, ccusageCommand, log, addCost } = options;
  try {
    await sandbox.exec("mkdir", ["-p", REVIEW_DIR], { cwd: sandbox.workspacePath });
    throwIfAborted(signal);

    log(
      "system",
      `starting codex review (${config.agent.reviewModel} at ${config.agent.reviewEffort} effort, ${REVIEW_ANGLES.length} reviewers)`,
    );

    const runReviewer = async (angle: ReviewAngle): Promise<number> => {
      const prompt = buildReviewerPrompt({ angle, ticket, outFile: `${REVIEW_DIR}/${angle.key}.md` });
      const exitCode = await runCodexExec({
        sandbox,
        config,
        signal,
        codexHome,
        ccusageCommand,
        prompt,
        addCost,
        costLabel: `review (${angle.key})`,
      });
      log("system", exitCode === 0 ? `codex reviewer (${angle.title}) finished` : `codex reviewer (${angle.title}) failed (exit ${exitCode})`);
      return exitCode;
    };

    // Cancellation propagates to each codex subprocess via the exec signal, so
    // this await also waits for cancelled reviewers to actually terminate
    // before the runner moves on to destroy the sandbox.
    const exitCodes = await Promise.all(REVIEW_ANGLES.map(runReviewer));
    throwIfAborted(signal);
    if (exitCodes.every((code) => code !== 0)) {
      log("system", "codex review failed: no reviewer completed");
      return undefined;
    }

    const synthesisPrompt = buildReviewSynthesisPrompt({ ticket, reviewDir: REVIEW_DIR, outFile: REVIEW_FILE });
    const synthesisExit = await runCodexExec({
      sandbox,
      config,
      signal,
      codexHome,
      ccusageCommand,
      prompt: synthesisPrompt,
      addCost,
      costLabel: "review (synthesis)",
    });
    throwIfAborted(signal);
    if (synthesisExit !== 0) {
      log("system", `codex review failed: synthesis pass failed (exit ${synthesisExit})`);
      return undefined;
    }

    let review: string;
    try {
      review = (await sandbox.readFile(REVIEW_FILE)).trim();
    } catch (error) {
      log("system", `codex review failed: ${REVIEW_FILE} was not written (${error instanceof Error ? error.message : String(error)})`);
      return undefined;
    }

    const body = review.replace(/^#\s*Codex review\s*\n/i, "").trim();
    if (body.toLowerCase() === NO_FINDINGS_MARKER.toLowerCase()) {
      log("system", "codex review: no confirmed findings");
      return undefined;
    }

    const truncated = review.length > REVIEW_LOG_MAX_CHARS ? `${review.slice(0, REVIEW_LOG_MAX_CHARS)}\n... (truncated)` : review;
    log("system", `codex review findings:\n${truncated}`);
    return review;
  } catch (error) {
    if (signal.aborted || error instanceof RunCancelledError) throw error;
    log("system", `codex review failed: ${error instanceof Error ? error.message : String(error)}; continuing without review`);
    return undefined;
  }
}

interface RunCodexExecOptions {
  sandbox: Sandbox;
  config: BreviConfig;
  signal: AbortSignal;
  codexHome: string | undefined;
  ccusageCommand?: string;
  prompt: string;
  addCost: (entry: CostEntry) => Promise<void>;
  costLabel: string;
}

/**
 * Runs one Codex exec (a reviewer or the synthesis pass) inside the run's
 * sandbox and records its usage. `--dangerously-bypass-approvals-and-sandbox`
 * is safe here because the sandbox itself (Firecracker or process) already
 * isolates the run; Codex's own CLI-level sandboxing would just be redundant.
 * Usage is read from ccusage over the run's CODEX_HOME session file when
 * available (real pricing), falling back to the stream-estimated figure.
 * Never throws on a non-zero exit, the caller decides what that means.
 */
async function runCodexExec(options: RunCodexExecOptions): Promise<number> {
  const { sandbox, config, signal, codexHome, ccusageCommand, prompt, addCost, costLabel } = options;
  const usage = usageCollector("codex");
  // Reviewer transcripts run three at a time; interleaving their raw output
  // into the console would be unreadable, so only usage observation reads
  // every line and nothing from stdout/stderr is logged directly.
  const stdoutSink = lineSink((line) => {
    try {
      usage.observe(JSON.parse(line));
    } catch {
      // Not JSON; ignored for the log.
    }
  });
  const stderrSink = lineSink(() => {});

  const exec = await sandbox.exec(
    "codex",
    [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      config.agent.reviewModel,
      "-c",
      `model_reasoning_effort=${config.agent.reviewEffort}`,
      prompt,
    ],
    {
      cwd: sandbox.workspacePath,
      env: codexHome ? { CODEX_HOME: codexHome } : undefined,
      timeoutMs: config.sandbox.timeoutMinutes * 60_000,
      signal,
      onStdout: (chunk) => stdoutSink.write(chunk),
      onStderr: (chunk) => stderrSink.write(chunk),
    },
  );
  stdoutSink.flush();
  stderrSink.flush();

  const subscription = !config.agent.codexApiKey;
  const streamEntry = usage.snapshot({
    label: costLabel,
    subscription,
    fallbackModel: config.agent.reviewModel,
  });

  let entry = streamEntry;
  const sessionId = usage.sessionId();
  if (ccusageCommand && sessionId) {
    const session = await readCodexSessionUsage({ sandbox, command: ccusageCommand, codexHome, sessionId, signal });
    // A ccusage read without a cost (the model is missing from its pricing
    // data) keeps the stream entry instead: its table estimate is better than
    // reporting no cost at all.
    if (session && session.costUsd !== undefined) {
      entry = ccusageCostEntry({
        label: costLabel,
        rows: session.rows,
        subscription,
        fallbackModel: streamEntry?.model ?? config.agent.reviewModel,
        provider: "codex",
        sessionCostUsd: session.costUsd,
      });
    }
  }
  if (entry) await addCost(entry);

  return exec.exitCode;
}
