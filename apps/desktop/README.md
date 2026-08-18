# @brevi/desktop

Mission Control is the only brevi host. Its Electron main process starts the orchestrator directly, serves the renderer from `brevi://app`, and protects the loopback management API with a random per-launch token.

```sh
bun run build
bun run start
bun run package
```

Remote Linux workers are provisioned from the Workers page over system SSH. Pairing tokens remain in the main process and are transferred through stdin to a short-lived remote file; they never enter renderer state or process arguments.

The version in this package is the authoritative desktop release version.
