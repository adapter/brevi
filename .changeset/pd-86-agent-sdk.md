---
---

Claude runs now execute through the Claude Agent SDK instead of a hand-rolled `claude -p` subprocess invocation and stream-json parser; the SDK drives the worker's installed `claude` binary inside the same sandbox, and run events, costs, limits, cancellation, and timeouts behave as before. No npm package publishes; the change ships with the desktop app.
