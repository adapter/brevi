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
export function buildImplementationPrompt(ticket: Ticket, repo: RepoConfig): string {
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
    "- Leave all changes uncommitted in the working tree. Do NOT run `git commit`, `git push`, or create branches — committing is handled for you.",
    "",
    "## Required outputs (all three are mandatory)",
    "1. Code changes in the working tree that implement the ticket.",
    "2. `.brevi/summary.md` — a pull-request-ready description of the change: what changed and why, how you verified it, and anything reviewers should pay attention to.",
    "3. A demo under `.brevi/demo/` proving the change works:",
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
    "Write your research to `.brevi/research.md` — the only file you may create or modify. Structure it as:",
    "- `## Context` — what the question is and why it matters here",
    "- `## Findings` — what you learned, with concrete file references from this codebase",
    "- `## Options` — viable approaches with their tradeoffs",
    "- `## Recommendation` — what you would do and why",
  ].join("\n");
}
