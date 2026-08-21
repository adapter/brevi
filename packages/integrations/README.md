# @brevi/integrations

Third-party service integrations shared by Mission Control's orchestrator and `@brevi/worker`: GitHub (PRs, feedback, commit identity), Linear, R2 evidence uploads, credential discovery and validation, agent usage-limit detection, per-repo memories, and machine usage reads.

Nothing here is scheduling state. Run stores, leases, and the worker registry stay in `@brevi/orchestrator`, and the dependency runs one way: this package imports only `@brevi/shared`.
