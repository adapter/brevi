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

/** Reads better than "all 4 are" for the counts the required-output list actually reaches. */
const COUNT_WORDS: Record<number, string> = { 2: "both are", 3: "all three are", 4: "all four are" };

/**
 * Render the required-output list, numbering each output's first line and
 * passing its continuation lines through. Which outputs a run owes depends on
 * the repo's demo policy and on whether memories are on, so the numbering
 * cannot be baked into the strings.
 */
function numberedOutputs(outputs: string[][]): string[] {
  return [
    `## Required outputs (${COUNT_WORDS[outputs.length] ?? `all ${outputs.length} are`} mandatory)`,
    ...outputs.flatMap((lines, index) => lines.map((line, i) => (i === 0 ? `${index + 1}. ${line}` : line))),
  ];
}

const REPLY_INSTRUCTION =
  "`.brevi/reply.md`: the PR comment that will be posted verbatim after your work is pushed. One short bullet per feedback item saying what you did (name the commit subject) or why you declined; when the rebase had conflicts, one line on how you resolved them. Write this file even when you conclude no code change is needed: every feedback item still gets its explanation. Concise, no headings, no restating diffs.";

function memoriesSection(memories: string[]): string {
  return [
    "## Repository memories",
    "",
    "Facts earlier brevi runs recorded about this repository, most recently confirmed first. They exist to save you the exploration they cost: lean on them instead of rediscovering the same things.",
    "",
    ...memories.map((memory) => `- ${memory}`),
    "",
    "They are notes from a previous session, not ground truth. Verify anything load-bearing against the actual code, and when one is wrong or stale, write the corrected fact in your memories output below.",
  ].join("\n");
}

/**
 * What the agent is asked to leave behind for the next run in this repo. The
 * bar is deliberately high: a memory has to still be true next month and has
 * to save real work, or it is just tokens every future run pays for.
 */
const MEMORIES_INSTRUCTION = [
  "`.brevi/memories.md`: what you now know about this repository that would have saved you time today, as `- ` bullets, one fact per line. Aim for three to eight, fewer if you learned little, and keep each under 200 characters.",
  "- Worth recording: where a concern actually lives, the command that really builds/tests/lints (and any that looks right but fails), a convention that is easy to get wrong, a non-obvious coupling between files, a trap that cost you time.",
  "- Not worth recording: anything about this ticket or your changes, anything already visible in the repository map, generic advice that would be true of any repo, or a fact you did not actually verify.",
  "- Write each one so it is useful to an agent starting cold on an unrelated ticket in this repo. Prefer the file paths and commands themselves over descriptions of them. An empty or missing file is a fine outcome; padding it costs every future run.",
];

/** Prompt for implementation tickets: code + summary + demo evidence. */
export function buildImplementationPrompt(
  ticket: Ticket,
  repo: RepoConfig,
  prDescription: "concise" | "detailed" = "concise",
  options: { repoMap?: RepoMap; delegate?: boolean; memories?: string[]; recordMemories?: boolean } = {},
): string {
  const { repoMap, delegate, memories, recordMemories } = options;
  const summaryInstruction =
    prDescription === "concise"
      ? "`.brevi/summary.md`: a very concise pull-request description with one or two sentences on what changed and why, then at most five short bullets covering how you verified it and anything reviewers must not miss. No headings, no restating the ticket."
      : "`.brevi/summary.md`: a pull-request-ready description of the change covering what changed and why, how you verified it, and anything reviewers should pay attention to.";

  const playwrightNote =
    "A Chromium browser for playwright may already be at `PLAYWRIGHT_BROWSERS_PATH` (a shared, read-only cache). If launching fails, install into `/tmp/ms-playwright` and set `PLAYWRIGHT_BROWSERS_PATH=/tmp/ms-playwright` for that session. Do not write into the shared cache. Chromium inside the sandbox needs `--no-sandbox` (`PLAYWRIGHT_CHROMIUM_SANDBOX` is already 0).";
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

  // Numbered here rather than written inline, because which outputs are
  // required depends on the repo's demo policy and on whether memories are on.
  const outputs: string[][] = [
    ["Code changes in the working tree that implement the ticket."],
    [summaryInstruction],
  ];
  if (repo.demo !== "never") {
    outputs.push([
      "A demo under `.brevi/demo/` proving the change works (shown in brevi's local dashboard; nothing under .brevi/ is committed or attached to the PR):",
      ...demoInstructions,
      "- Screenshots must be .png, recordings .webm, text evidence .txt. Give files short descriptive names.",
    ]);
  }
  if (recordMemories) outputs.push(MEMORIES_INSTRUCTION);

  const requiredOutputs = numberedOutputs(outputs);

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
    ...(memories && memories.length > 0 ? ["", memoriesSection(memories)] : []),
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

/** Prompt for a follow-up session: rebase the PR branch, address review feedback, prepare the reply. */
export function buildFollowUpPrompt(options: {
  ticket: Ticket;
  prUrl: string;
  branch: string;
  baseBranch: string;
  /** Pre-formatted feedback bundle (markdown), or empty when there is none. */
  feedback: string;
  /** Operator-typed instructions from the dashboard, verbatim; absent on plain follow-ups. */
  instructions?: string;
  rebase: { status: "clean" } | { status: "conflicted"; detail: string };
  delegate?: boolean;
  /** Facts earlier runs recorded about this repo; empty or absent when memories are off. */
  memories?: string[];
  /** Ask for `.brevi/memories.md` back, so this session's learning is kept too. */
  recordMemories?: boolean;
}): string {
  const { ticket, prUrl, branch, baseBranch, feedback, instructions, rebase, delegate, memories, recordMemories } =
    options;
  return [
    `You are an autonomous coding agent working in a git checkout of the pull request branch \`${branch}\` for the ticket below. The PR (${prUrl}) has received review feedback and/or drifted behind its base branch \`${baseBranch}\`. Bring the branch up to date and address the feedback end to end without asking questions.`,
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
    ...(memories && memories.length > 0 ? ["", memoriesSection(memories)] : []),
    "",
    "## Rebase state",
    rebase.status === "clean"
      ? `The branch has already been rebased onto \`origin/${baseBranch}\` cleanly before this session; do not redo the rebase.`
      : [
          `A rebase onto \`origin/${baseBranch}\` is in progress and stopped on conflicts. Resolve every conflict faithfully, preserving both the PR's intent and the base branch's changes, then run \`GIT_EDITOR=true git rebase --continue\` until the rebase completes. Current conflict state:`,
          "```",
          rebase.detail,
          "```",
        ].join("\n"),
    ...(instructions
      ? [
          "",
          "## Operator instructions",
          "The operator who requested this follow-up asked for the following. Treat it as feedback to address alongside anything under Review feedback below:",
          instructions,
        ]
      : []),
    "",
    "## Review feedback",
    feedback || "(none: this follow-up only brings the branch up to date)",
    "",
    "## Rules",
    "- Address every feedback item: implement what the reviewer asked, or, when you are convinced they are mistaken, leave the code alone and say why in your reply (below).",
    "- Unlike other brevi sessions, you MUST commit your work here: make focused commits with clear messages so each feedback item maps to a commit. Do NOT push, and never commit anything under `.brevi/`.",
    "- Do not resolve review threads, post comments, or otherwise touch GitHub yourself; replying is handled for you.",
    "- Run the repo's tests/linters relevant to what you change and fix what you break.",
    `- ${NO_EM_DASHES}`,
    "",
    ...(recordMemories
      ? numberedOutputs([[REPLY_INSTRUCTION], MEMORIES_INSTRUCTION])
      : ["## Required output", REPLY_INSTRUCTION]),
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
