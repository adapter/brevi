---
"@brevi/cli": patch
---

Fixes the console noise filter to match how Claude Code really emits status and thinking_tokens (system-event subtypes), so they stay out of the log.
