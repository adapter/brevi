import type { RepoConfig, Ticket } from "@brevi/shared";

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

/** Prompt for implementation tickets: code + summary + demo evidence. */
export function buildImplementationPrompt(
  ticket: Ticket,
  repo: RepoConfig,
  prDescription: "concise" | "detailed" = "concise",
): string {
  const summaryInstruction =
    prDescription === "concise"
      ? "2. `.brevi/summary.md`: a very concise pull-request description with one or two sentences on what changed and why, then at most five short bullets covering how you verified it and anything reviewers must not miss. No headings, no restating the ticket."
      : "2. `.brevi/summary.md`: a pull-request-ready description of the change covering what changed and why, how you verified it, and anything reviewers should pay attention to.";
  const demoInstructions = repo.devCommand
    ? [
        `- This repo has a dev server. Start it with \`${repo.devCommand}\`${
          repo.devUrl ? `, wait until ${repo.devUrl} responds` : ""
        }, then use playwright (install a browser with \`npx playwright install chromium\` if needed) to capture real screenshots of the affected screens${
          repo.devUrl ? ` at ${repo.devUrl}` : ""
        }. Save them as .png files in .brevi/demo/. Stop the dev server when you are done.`,
      ]
    : [
        "- Capture the most meaningful visual evidence available for this change: if a dev server or UI can run, real screenshots via playwright saved as .png; otherwise a screen recording as .webm, or failing that the relevant test output or a CLI transcript saved as a .txt file in .brevi/demo/.",
      ];

  return [
    "You are an autonomous coding agent working in a git checkout of the repository in the current directory. Complete the ticket below end to end without asking questions.",
    "",
    ticketSection(ticket),
    "",
    "## Rules",
    "- Follow the repository's existing conventions (read its README, package manifests, and lint/test setup first).",
    "- Run the repo's tests/linters relevant to your change and fix what you break.",
    "- Leave all changes uncommitted in the working tree. Do NOT run `git commit`, `git push`, or create branches; committing is handled for you.",
    "- Never use em dashes (\u2014) or spaced hyphens standing in for them in anything you write: code, comments, docs, `.brevi/summary.md`, PR titles or bodies, and ticket comments. Reword the sentence instead: split it, or use a comma, colon, or parentheses.",
    "",
    "## Required outputs (all three are mandatory)",
    "1. Code changes in the working tree that implement the ticket.",
    summaryInstruction,
    "3. A demo under `.brevi/demo/` proving the change works (shown in brevi's local dashboard; nothing under .brevi/ is committed or attached to the PR):",
    ...demoInstructions,
    "- Screenshots must be .png, recordings .webm, text evidence .txt. Give files short descriptive names.",
  ].join("\n");
}

/** Prompt for SPIKE tickets: research only, no code changes. */
export function buildSpikePrompt(ticket: Ticket): string {
  return [
    "You are a research agent. Investigate the question in the ticket below against this repository (checked out in the current directory) and your own knowledge. This is a SPIKE: do NOT modify any code.",
    "",
    ticketSection(ticket),
    "",
    "## Required output",
    "Never use em dashes (\u2014) or spaced hyphens standing in for them anywhere in your writing. Reword the sentence instead: split it, or use a comma, colon, or parentheses.",
    "Write your research to `.brevi/research.md`, the only file you may create or modify. Structure it as:",
    "- `## Context`: what the question is and why it matters here",
    "- `## Findings`: what you learned, with concrete file references from this codebase",
    "- `## Options`: viable approaches with their tradeoffs",
    "- `## Recommendation`: what you would do and why",
  ].join("\n");
}
