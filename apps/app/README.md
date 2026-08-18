# @brevi/app

Mission Control's React renderer. Production builds are copied into the Electron package and loaded from the private `brevi://app` origin; they are not hosted as a standalone website.

```sh
bun run dev
bun run build
```

The renderer talks to the orchestrator's loopback API with a random per-launch token supplied by Electron.
