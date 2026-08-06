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

/**
 * Prompt for the planning phase of implementation runs: explore and produce
 * `.brevi/plan.md` for a separate implementation agent, no code changes.
 */
export function buildPlanPrompt(ticket: Ticket, repoMap?: RepoMap): string {
  return [
    "You are the planning agent of an automated two-phase run. Explore the repository checked out in the current directory and write an implementation plan for the ticket below. Do NOT implement anything: a separate implementation agent will execute your plan in this same checkout, with no context beyond the plan itself.",
    "",
    ticketSection(ticket),
    ...(repoMap ? ["", repoMapSection(repoMap)] : []),
    "",
    "## Required output",
    "Write the plan to `.brevi/plan.md`, the only file you may create or modify. Make it concrete enough to execute without re-deriving your research, and keep it under roughly 150 lines:",
    "- `## Approach`: the change in a few sentences and why this approach fits this codebase",
    "- `## Steps`: ordered steps naming the exact files to create or edit (paths from the repo root) and what changes in each",
    "- `## Verification`: the tests/linters to run and what proves the change works",
    "- `## Risks`: what is easy to get wrong (edge cases, coupled files, repo conventions the implementer must follow)",
    NO_EM_DASHES,
  ].join("\n");
}

/** Prompt for implementation tickets: code + summary + demo evidence. */
export function buildImplementationPrompt(
  ticket: Ticket,
  repo: RepoConfig,
  prDescription: "concise" | "detailed" = "concise",
  options: { repoMap?: RepoMap; hasPlan?: boolean } = {},
): string {
  const { repoMap, hasPlan } = options;
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
    ...(hasPlan
      ? [
          "",
          "A planning agent already explored this repository and wrote an implementation plan to `.brevi/plan.md`. Read it first and follow it instead of re-planning from scratch. Where the code contradicts the plan, trust the code and note the deviation in `.brevi/summary.md`.",
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
