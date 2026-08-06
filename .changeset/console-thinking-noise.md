---
"@brevi/cli": patch
---

The run console no longer leaks stray `status` and repeated `thinking_tokens` notes while the thinking spinner runs. The runner drops these token-progress/status stream events before persisting (so events.jsonl stays lean), scopes thinking tracking to the top-level assistant stream so subagent streams cannot duplicate "Thought for Ns" lines, and the dashboard now renders nothing for unknown low-signal event types and coalesces back-to-back thinking events into one line. The live spinner row also counts up ("Thinking… 23s") instead of showing a static label.
