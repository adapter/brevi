---
title: Tickets and runs
description: How brevi decides which Linear issues to pick up, which repository they run against, what a run produces, and when a ticket runs again.
---

brevi polls Linear on an interval (`pollIntervalSeconds`, 60 by default), turns eligible issues into a queue, and executes them one at a time.

## Which tickets brevi picks up

An issue is eligible when **all** of these hold:

1. It is **assigned to you**, meaning the user the connected Linear credential belongs to.
2. Its state type is **`unstarted` or `backlog`**. Issues already started, done, or cancelled are ignored.
3. It is in one of `linear.teamKeys`, if you set that list. Empty means all teams.
4. It **opts in** by carrying the trigger label (`brevi` by default, matched case-insensitively).

The label name is configurable under `trigger` in the config.

Every run implements its ticket end to end: the agent changes the code, writes `.brevi/summary.md`, and captures a demo under `.brevi/demo/`; brevi pushes a branch and opens a pull request, plus a Linear comment linking to it. Because every run pushes a branch, GitHub must be connected.

## Which repository a ticket runs against

Repository mappings live in `config.repos` as *key → repo* entries; the dashboard creates them when you pick repos from GitHub. brevi resolves a ticket's repo in this order, stopping at the first hit:

1. A label of the form **`repo:<key>`** (case-insensitive).
2. A label that **exactly matches a repo key**.
3. The issue's project appearing in a repo's **`projects` list** (the Linear-project mapping edited on the dashboard's Configuration page).
4. The issue's **project name** matching a repo key.
5. **`config.defaultRepo`**, if it names a real entry in `config.repos`.

A ticket that resolves to nothing is still shown in the dashboard queue, but it is never auto-queued; the orchestrator logs a warning once, telling you to add a `repo:<key>` label, rename the project, or set a default. The same is true while GitHub is disconnected.

## What a run does

Runs execute serially (one at a time, FIFO) and move through the statuses `queued` → `preparing` → `running` → `finalizing` → `completed`, or `failed` / `cancelled`.

**Preparing.** brevi clones the mapped repo (depth 50, default branch, or from `repo.path` if you configured a local checkout), rewrites `origin` to a token-free URL, creates the branch `brevi/<ticket-identifier>` in lowercase, creates the sandbox, and pushes the checkout into it. Best effort, it also moves the Linear issue to its team's first "started" state.

**Running.** The configured agent command runs headless inside the sandbox with the generated prompt. Structured `stream-json` output is parsed and forwarded to the dashboard as it arrives, so you watch the run live. Each agent execution is killed at `sandbox.timeoutMinutes` (240, four hours, by default), and a coding agent that times out or exits non-zero fails the run.

As soon as the coding phase finishes, brevi checkpoints it: the workspace is pulled out, committed, force-pushed to `brevi/<ticket-id>`, and opened as a **draft** pull request, with a Linear comment linking to it. Everything after that point can fail, time out, or be cancelled without losing the implementation, and a retry updates the same PR instead of starting from nothing. The checkpoint is best effort: if it fails the run carries on, since finalizing pushes and opens the PR anyway.

For Claude runs, an adversarial Codex review of the uncommitted diff then runs in the same sandbox and can drive a fix pass before the PR leaves draft; see [Codex review](/reference/configuration/#codex-review).

**Finalizing.** The workspace is pulled back out and artifacts collected: everything under `.brevi/demo/` (nested paths flattened, so `demo/web/home.png` is stored as `web__home.png`), plus `.brevi/summary.md` and `.brevi/memories.md`. Artifacts are kept with the run under `~/.brevi/runs/` and served by the dashboard.

Then brevi removes everything under `.brevi/` (agent outputs stay with the run's artifacts), stages the rest, and fails with `agent made no changes` if the tree is clean. Otherwise it commits `<ID>: <title>`, force-pushes `brevi/<ticket-id>`, and opens a pull request against the repo's default branch, or updates the checkpointed draft and marks it ready for review. The PR body is the agent's `summary.md`, `Fixes <ID>`, and a brevi footer. brevi comments on the Linear issue with the PR link unless the checkpoint already did (a failure here does not fail the run).

When a run completes successfully, brevi also moves the Linear issue to a review state: the team's first `started`-type state whose name mentions "review" (e.g. **In Review**). Best effort: teams without such a state keep the issue where it is.

### Memories

The sandbox is thrown away after every run, so the next ticket in the same repo would otherwise re-explore it from scratch. To stop paying that twice, the agent is asked for one more file: `.brevi/memories.md`, a handful of durable facts about the repository worth knowing next time (the command that really builds it, where a concern lives, a convention that is easy to get wrong). brevi merges them into `~/.brevi/memories/<repo>.json` and injects them into the next run's prompt. See [`memory`](/reference/configuration/#memory) for the settings and how to drop a memory that turned out wrong.

### Demos

The run prompt makes a demo mandatory. If the repo config sets `devCommand` (and optionally `devUrl`), the agent is told to start that dev server and capture real screenshots with Playwright. Otherwise it captures the best available evidence: screenshots, else a `.webm` recording, else test output or a CLI transcript as `.txt`. Files go in `.brevi/demo/` and are collected as run artifacts, viewable on the run's page in the dashboard; they are not committed to the branch or attached to the PR.

## Reruns

Auto-queueing is keyed on the pair **(ticket id, `updatedAt`)**:

- A ticket that already has a run for its current `updatedAt` is skipped, so polling is idempotent.
- **Edit the ticket after a run finished and it runs again.** The new `updatedAt` makes it a new revision; the branch is force-pushed and the existing open pull request has its title and body updated rather than a second PR being opened.
- A ticket with a `queued`, `preparing`, `running`, or `finalizing` run is never queued again.
- Note that moving an issue out of `unstarted`/`backlog` (which brevi itself does when a run starts) removes it from the eligible set until it moves back.

You can also queue a ticket by hand from the dashboard, which bypasses the revision check but still refuses when a run is already active for it. Active runs can be cancelled; the sandbox is destroyed and the run ends as `cancelled`.
