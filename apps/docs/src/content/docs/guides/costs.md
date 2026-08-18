---
title: Costs and usage
description: How run costs are tracked, and how to query Brevi worker Claude usage with ccusage on the host.
---

Every run reports its own cost breakdown to Mission Control while it executes: live per-model samples during Claude runs, and a final per-execution entry when each agent execution ends. That normalized reporting drives the cost figures on a run's page and needs no setup.

Separately, the host keeps a durable, ccusage-readable archive of the Claude usage its workers generate, so `ccusage` on the desktop machine can account for remote runs it would otherwise never see.

## The host usage archive

Claude executions run on Linux workers, and each session's transcript lives inside that run's sandbox home on the worker. After every agent execution (including failed, cancelled, usage-limited, retried, and follow-up executions, and again when an attached terminal exits), the worker exports a minimized snapshot of the session and Mission Control archives it at:

```text
~/.brevi/ccusage/claude/projects/<project-key>/<session-id>.jsonl
```

The snapshot keeps only what usage accounting needs: event type and timestamp, session, request, and message ids, the model, the four token counts, and any pre-calculated cost. Prompt and response text, thinking, tool calls and results, repository content, credentials, and filesystem paths never leave the worker. A re-exported session (a retry, a resumed terminal) replaces its file wholesale, so nothing is ever double-counted.

## Querying with ccusage

[ccusage](https://ccusage.com) reads custom data roots through `CLAUDE_CONFIG_DIR`. Only Brevi worker usage:

```bash
CLAUDE_CONFIG_DIR="$HOME/.brevi/ccusage/claude" \
  ccusage claude daily
```

Local Claude Code usage and Brevi worker usage together, via comma-separated roots:

```bash
CLAUDE_CONFIG_DIR="$HOME/.claude,$HOME/.config/claude,$HOME/.brevi/ccusage/claude" \
  ccusage claude daily
```

Any other ccusage command (`monthly`, `session`, `blocks`) works against the same roots.

## Retention

The archive is accounting, not run state: it lives outside `~/.claude`, `~/.brevi/runs`, and `~/.brevi/workspaces`, and no run cleanup (artifact deletion, sandbox reaping, archiving a run in the dashboard) ever touches it. It grows by one small file per Claude session and is kept indefinitely. Reclaiming the space is an explicit operator action: delete `~/.brevi/ccusage`, which only forgets historical usage and affects nothing else.
