# brevi

Mission Control is the only host. Its Electron main process owns the orchestrator, loads `apps/app` from `brevi://app`, and provisions Linux workers over SSH.

## Workspaces

- `apps/desktop`: Electron host and desktop release.
- `apps/app`: local-only React renderer.
- `packages/orchestrator`: scheduler and private loopback API.
- `packages/worker`: dedicated `brevi-worker` daemon, binary, and installer.
- `packages/sandbox`: bubblewrap provider.
- `packages/shared`: config, domain, and wire types.
- `apps/api`: hosted OAuth helper.
- `apps/docs`: brevi.dev.

## Commands

```sh
bun install
bun run build
bun run lint
bun run check-types
bun test
cd apps/desktop && bun run start
```

## Rules

- Never use em dashes (U+2014) outside changelogs; CI rejects them.
- Runtime state lives under `~/.brevi`.
- Mission Control always binds its management API to loopback and requires a random per-launch token. Only the authenticated worker channel may bind to the network.
- SSH secrets and pairing tokens stay in Electron's main process. Never place them in renderer state, logs, config, or process arguments.
- Commit and PR titles start with the Linear ticket, for example `PD-75: ...`.
- Do not add attribution trailers.
- `apps/desktop/package.json` owns the desktop version. `packages/worker/package.json` owns the dedicated worker version; keep release versions coordinated.
- CI still requires a changeset file. Use an empty changeset for desktop releases because no npm package is published.
