---
---

Internal restructure: GitHub, Linear, R2, credential, usage-limit, memory, and machine-usage modules move from the orchestrator into a new @brevi/integrations workspace package, the worker no longer imports @brevi/orchestrator (the /internal barrel is gone), config file IO and path-safety helpers move to @brevi/shared, and the Orchestrator class sheds its PR passthroughs (PullService) and provider connect flows (connectors.ts). No behavior changes; no npm package publishes.
