---
"@brevi/cli": patch
---

Tickets now reliably end up In Review after a successful run: brevi re-asserts the state when Linear's GitHub automation reverts it, and logs every move.
