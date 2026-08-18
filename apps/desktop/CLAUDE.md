# Mission Control desktop

The Electron main process imports and starts `@brevi/orchestrator` directly. `supervisor.ts` serializes start, restart, and stop for the in-process handle. `protocol.ts` serves the renderer from `brevi://app`; `ssh.ts` provisions remote workers with system OpenSSH.

The renderer gets a random management token in its private URL. SSH keys and worker pairing tokens never cross into renderer state. The management listener is always loopback-only.

Packaging copies `apps/app/dist` into `dist/app` and bundles the orchestrator. `@lydell/node-pty` remains external so electron-builder packages its native addon. The desktop package version is authoritative.
