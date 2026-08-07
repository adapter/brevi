---
"@brevi/cli": patch
---

Harden GitHub token handling in the orchestrator by using a constant-time comparison when resolving the commit identity, preventing timing attacks.
