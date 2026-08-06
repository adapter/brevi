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
import { usageCollector } from "./costs.js";
import { buildReviewerPrompt, buildReviewSynthesisPrompt, type ReviewAngle } from "./prompts.js";
import { lineSink, raceWithAbort, RunCancelledError, throwIfAborted } from "./util.js";

/** True when the review is on in config and a Codex credential is actually available to run it with. */
export function codexReviewEnabled(config: BreviConfig): boolean {
  return config.agent.codexReview && (config.agent.codexApiKey !== "" || config.agent.codexAuthJson !== "");
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
 * throwIfAborted/raceWithAbort raising RunCancelledError).
 */
export async function runCodexReview(options: CodexReviewOptions): Promise<string | undefined> {
  const { sandbox, config, ticket, signal, codexHome, log, addCost } = options;
  try {
    await sandbox.exec("mkdir", ["-p", REVIEW_DIR], { cwd: sandbox.workspacePath });
    throwIfAborted(signal);

    log(
      "system",
      `starting codex review (${config.agent.reviewModel} at ${config.agent.reviewEffort} effort, ${REVIEW_ANGLES.length} reviewers)`,
    );

    const runReviewer = async (angle: ReviewAngle): Promise<number> => {
      const prompt = buildReviewerPrompt({ angle, ticket, outFile: `${REVIEW_DIR}/${angle.key}.md` });
      const exitCode = await runCodexExec({ sandbox, config, codexHome, prompt, addCost, costLabel: `review (${angle.key})` });
      log("system", exitCode === 0 ? `codex reviewer (${angle.title}) finished` : `codex reviewer (${angle.title}) failed (exit ${exitCode})`);
      return exitCode;
    };

    const exitCodes = await raceWithAbort(Promise.all(REVIEW_ANGLES.map(runReviewer)), signal);
    if (exitCodes.every((code) => code !== 0)) {
      log("system", "codex review failed: no reviewer completed");
      return undefined;
    }

    const synthesisPrompt = buildReviewSynthesisPrompt({ ticket, reviewDir: REVIEW_DIR, outFile: REVIEW_FILE });
    const synthesisExit = await raceWithAbort(
      runCodexExec({ sandbox, config, codexHome, prompt: synthesisPrompt, addCost, costLabel: "review (synthesis)" }),
      signal,
    );
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
  codexHome: string | undefined;
  prompt: string;
  addCost: (entry: CostEntry) => Promise<void>;
  costLabel: string;
}

/**
 * Runs one Codex exec (a reviewer or the synthesis pass) inside the run's
 * sandbox and records its usage. `--dangerously-bypass-approvals-and-sandbox`
 * is safe here because the sandbox itself (Firecracker or process) already
 * isolates the run; Codex's own CLI-level sandboxing would just be redundant.
 * Never throws on a non-zero exit, the caller decides what that means.
 */
async function runCodexExec(options: RunCodexExecOptions): Promise<number> {
  const { sandbox, config, codexHome, prompt, addCost, costLabel } = options;
  const usage = usageCollector();
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
      onStdout: (chunk) => stdoutSink.write(chunk),
      onStderr: (chunk) => stderrSink.write(chunk),
    },
  );
  stdoutSink.flush();
  stderrSink.flush();

  const entry = usage.snapshot({ label: costLabel, provider: "codex", subscription: !config.agent.codexApiKey });
  if (entry) await addCost(entry);

  return exec.exitCode;
}
