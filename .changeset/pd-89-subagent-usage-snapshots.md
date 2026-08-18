---
---

Workers now export subagent transcripts alongside the main session in the post-run Claude usage snapshot, and Mission Control archives each one under the session's `subagents/` directory in the ccusage archive, replacing wholesale on re-export just like the main-session file, so host-side ccusage totals include subagent usage instead of permanently undercounting runs that delegated to subagents; the worker protocol version bumps to 5. No npm package publishes; the change ships with the desktop app.
