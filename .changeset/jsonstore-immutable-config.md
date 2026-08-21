---
---

Internal restructure: the five stores' hand-rolled serialized write chains and atomic temp-file-then-rename writes dedupe into a shared WriteQueue/atomicWriteFile helper in @brevi/shared, and the orchestrator's config becomes an immutable snapshot with one serialized update path, replacing the in-place mutation, two-level transaction chain, double-write reconcile, and own-write watcher bookkeeping. No behavior changes; no npm package publishes.
