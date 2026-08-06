import type { RepoConfig, Ticket } from "@brevi/shared";

/** Orientation generated from the checkout by the runner, injected into every prompt. */
export interface RepoMap {
  /** `git ls-files` output, possibly truncated with a trailing note. */
  tree: string;
  /** Recent `git log --oneline` subjects. */
  commits: string;
}

// The escape keeps the literal U+2014 character out of this file (CI rejects it).
const NO_EM_DASHES =
  "Never use em dashes (\u2014) or spaced hyphens standing in for them in anything you write: code, comments, docs, `.brevi/` files, PR titles or bodies, and ticket comments. Reword the sentence instead: split it, or use a comma, colon, or parentheses.";

function ticketSection(ticket: Ticket): string {
  return [
    "## Ticket",
    "",
    `${ticket.identifier}: ${ticket.title}`,
    ticket.url,
    "",
    ticket.description.trim() || "(no description provided)",
  ].join("\n");
}

function repoMapSection(repoMap: RepoMap): string {
  return [
    "## Repository map",
    "",
    "Generated from this checkout to save you orientation work; trust the actual files over this snapshot.",
    "",
    "Recent commits:",
    "```",
    repoMap.commits,
    "```",
    "",
    "Files:",
    "```",
    repoMap.tree,
    "```",
  ].join("\n");
}

/** Prompt for implementation tickets: code + summary + demo evidence. */
export function buildImplementationPrompt(
  ticket: Ticket,
  repo: RepoConfig,
  prDescription: "concise" | "detailed" = "concise",
  options: { repoMap?: RepoMap; delegate?: boolean } = {},
): string {
  const { repoMap, delegate } = options;
  const summaryInstruction =
    prDescription === "concise"
      ? "2. `.brevi/summary.md`: a very concise pull-request description with one or two sentences on what changed and why, then at most five short bullets covering how you verified it and anything reviewers must not miss. No headings, no restating the ticket."
      : "2. `.brevi/summary.md`: a pull-request-ready description of the change covering what changed and why, how you verified it, and anything reviewers should pay attention to.";

  const playwrightNote =
    "A Chromium browser for playwright is already provisioned: `PLAYWRIGHT_BROWSERS_PATH` points at a shared browser cache, so do not reinstall it per run. Only if launching fails, run `npx playwright install chromium` once; it installs into that shared cache.";
  const demoInstructions = repo.devCommand
    ? [
        `- This repo has a dev server. Start it with \`${repo.devCommand}\`${
          repo.devUrl ? `, wait until ${repo.devUrl} responds` : ""
        }, then use playwright to capture real screenshots of the affected screens${
          repo.devUrl ? ` at ${repo.devUrl}` : ""
        }. Save them as .png files in .brevi/demo/. Stop the dev server when you are done.`,
        `- ${playwrightNote}`,
      ]
    : [
        "- Capture the most meaningful visual evidence available for this change: if a dev server or UI can run, real screenshots via playwright saved as .png; otherwise a screen recording as .webm, or failing that the relevant test output or a CLI transcript saved as a .txt file in .brevi/demo/.",
        `- ${playwrightNote}`,
      ];
  if (repo.demo === "auto") {
    demoInstructions.push(
      "- Proportionality: if the change has no visible surface (docs-only, test-only, config, pure refactor), skip the dev server and screenshots entirely and save the relevant test output or a short CLI transcript as a .txt file instead. Spend demo effort only where a reviewer gains something from seeing it.",
    );
  }

  const requiredOutputs =
    repo.demo === "never"
      ? [
          "## Required outputs (both are mandatory)",
          "1. Code changes in the working tree that implement the ticket.",
          summaryInstruction,
        ]
      : [
          "## Required outputs (all three are mandatory)",
          "1. Code changes in the working tree that implement the ticket.",
          summaryInstruction,
          "3. A demo under `.brevi/demo/` proving the change works (shown in brevi's local dashboard; nothing under .brevi/ is committed or attached to the PR):",
          ...demoInstructions,
          "- Screenshots must be .png, recordings .webm, text evidence .txt. Give files short descriptive names.",
        ];

  return [
    "You are an autonomous coding agent working in a git checkout of the repository in the current directory. Complete the ticket below end to end without asking questions.",
    ...(delegate
      ? [
          "",
          "## Orchestration",
          "You are the orchestrator of this run, on a stronger model; an `implementer` subagent on a faster model is available through your agent tool. Keep the thinking for yourself and delegate the labor:",
          "- Plan the change yourself, then break it into well-scoped tasks and dispatch every substantive implementation task (code edits, running tests, demo capture) to `implementer` subagents, in parallel when tasks are independent.",
          "- Give each subagent complete instructions: the exact files, the change to make, the conventions to follow, and how to verify it. It starts with no context beyond your prompt.",
          "- Review what each subagent returns and iterate; fixing small residual issues yourself is fine, re-implementing the whole ticket yourself is not.",
        ]
      : []),
    "",
    ticketSection(ticket),
    ...(repoMap ? ["", repoMapSection(repoMap)] : []),
    "",
    "## Rules",
    "- Follow the repository's existing conventions (read its README, package manifests, and lint/test setup first).",
    "- Run the repo's tests/linters relevant to your change and fix what you break.",
    "- Leave all changes uncommitted in the working tree. Do NOT run `git commit`, `git push`, or create branches; committing is handled for you.",
    `- ${NO_EM_DASHES}`,
    "",
    ...requiredOutputs,
  ].join("\n");
}

/** Prompt for SPIKE tickets: research only, no code changes. */
export function buildSpikePrompt(ticket: Ticket, repoMap?: RepoMap): string {
  return [
    "You are a research agent. Investigate the question in the ticket below against this repository (checked out in the current directory) and your own knowledge. This is a SPIKE: do NOT modify any code.",
    "",
    ticketSection(ticket),
    ...(repoMap ? ["", repoMapSection(repoMap)] : []),
    "",
    "## Required output",
    NO_EM_DASHES,
    "Write your research to `.brevi/research.md`, the only file you may create or modify. Structure it as:",
    "- `## Context`: what the question is and why it matters here",
    "- `## Findings`: what you learned, with concrete file references from this codebase",
    "- `## Options`: viable approaches with their tradeoffs",
    "- `## Recommendation`: what you would do and why",
  ].join("\n");
}

/** One independent brief in the adversarial Codex review; the angle list itself lives in review.ts. */
export interface ReviewAngle {
  key: string;
  title: string;
  instruction: string;
}

/** Prompt for one adversarial reviewer, judging the uncommitted implementation from a single angle. */
export function buildReviewerPrompt(options: { angle: ReviewAngle; ticket: Ticket; outFile: string }): string {
  const { angle, ticket, outFile } = options;
  return [
    `You are an adversarial code reviewer with the "${angle.title}" brief. The working tree of this repository contains an uncommitted implementation of the ticket below. Inspect it with \`git status\` and \`git diff HEAD\`; untracked files are part of the change, and everything under \`.brevi/\` is run scaffolding to ignore.`,
    angle.instruction,
    "",
    ticketSection(ticket),
    "",
    "## Rules",
    "- Judge only against two sources of truth: the ticket text above and the actual code in this repository. Read the surrounding code before calling something wrong.",
    "- Report only findings you can support with concrete evidence (file and line references). An empty report is a valid outcome; do not pad.",
    `- ${NO_EM_DASHES}`,
    `- Write your findings to \`${outFile}\` and change nothing else. For each finding: a \`### \` heading, a severity (blocker, major, or minor), the files involved, what is wrong, and the evidence. If you found nothing from your brief, write exactly \`No findings.\``,
  ].join("\n");
}

/** Prompt for the synthesis pass: verify and rank the independent reviewers' findings. */
export function buildReviewSynthesisPrompt(options: { ticket: Ticket; reviewDir: string; outFile: string }): string {
  const { ticket, reviewDir, outFile } = options;
  return [
    `You are the synthesis pass of an adversarial code review. Independent reviewers examined the uncommitted implementation of the ticket below and wrote their findings to markdown files under \`${reviewDir}/\`.`,
    "",
    ticketSection(ticket),
    "",
    "## Task",
    `- Read every findings file under \`${reviewDir}/\` (a reviewer that crashed may have left no file), then verify each finding against the actual working tree: \`git diff HEAD\` plus the surrounding code. Drop findings that are wrong, duplicated, or pure style preference.`,
    "- Merge duplicates and rank what survives from most to least severe.",
    `- ${NO_EM_DASHES}`,
    `- Write the result to \`${outFile}\` and change nothing else. Start with a \`# Codex review\` heading, then one \`## <n>. <title>\` section per confirmed finding with its severity, the files involved, what is wrong, and how to fix it. If no finding survives verification, write exactly \`No confirmed findings.\` under the heading.`,
  ].join("\n");
}

/** Prompt for the orchestrator's fix pass, applied only when the review confirmed findings. */
export function buildReviewFixPrompt(options: { ticket: Ticket; findings: string; delegate?: boolean }): string {
  const { ticket, findings, delegate } = options;
  return [
    "You are the coding agent responsible for the ticket below; its implementation sits uncommitted in this working tree. An adversarial review of that implementation confirmed the findings underneath. Address them.",
    ...(delegate
      ? ["An `implementer` subagent on a faster model is available through your agent tool; dispatch well-scoped fixes to it and review what it returns."]
      : []),
    "",
    ticketSection(ticket),
    "",
    "## Rules",
    "- Fix every finding that is real; when a finding is mistaken, leave the code alone.",
    "- Keep `.brevi/summary.md` accurate if your fixes change what a PR reviewer should know.",
    "- Do not modify `.brevi/review.md` or anything under `.brevi/review/`.",
    "- Rerun the checks relevant to what you change.",
    "- Leave all changes uncommitted in the working tree. Do NOT run `git commit`, `git push`, or create branches.",
    `- ${NO_EM_DASHES}`,
    "",
    "## Confirmed review findings",
    findings,
  ].join("\n");
}
