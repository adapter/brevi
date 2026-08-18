# Orchestrator

Mission Control's scheduler and private management API. It no longer serves dashboard files. The desktop imports `startOrchestrator()` and owns the returned handle.

The management listener is forced to `127.0.0.1` and protected by a per-launch token. The separate fleet listener serves only authenticated worker traffic and may bind to the network.
