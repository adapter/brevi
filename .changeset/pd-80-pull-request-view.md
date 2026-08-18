---
---

Mission Control gains a Pull Requests view, opened from a sidebar entry above the runs: every configured repository's PRs in one list, with a Codex-style detail page covering the description, conversation (comments, reviews, and review threads with inline diff hunks, replies, and resolution), file diffs, commits, and checks, plus merge, close, reopen, ready-for-review, and review submission, all proxied through the orchestrator so the GitHub token never reaches the renderer. Ticket-to-repo routing no longer treats the trigger label as a bare repo-key match, so a repo keyed like the trigger label (e.g. "brevi") stops swallowing every ticket ahead of the issue's project mapping. No npm package publishes; the change ships with the desktop app.
