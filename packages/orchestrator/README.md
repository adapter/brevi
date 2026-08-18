# @brevi/orchestrator

Mission Control's scheduling engine. It polls Linear, dispatches work to connected Linux workers, tracks runs and pull requests, and exposes a private loopback HTTP/WebSocket API to the Electron renderer.

The package does not serve a web application. `apps/desktop` imports `startOrchestrator()` directly and owns its lifecycle.
