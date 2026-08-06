# @brevi/cli

The published `brevi` command line (bin: `dist/index.js`). Thin layer over `@brevi/orchestrator`: parses commands with commander, runs the init flow, starts the orchestrator, opens the dashboard.

## Layout

- `src/index.ts`: entry point and command registration
- `src/commands/`: one file per command (`init`, `ui`/default, `start`, `status`, `update`)
- `src/lib/`: prompt helpers (@clack/prompts), config discovery, update logic

## Gotchas

- `bun run build` bundles with `bun build` and copies the dashboard build into `dist/app` from `../../apps/app/dist`, so `apps/app` must be built first (turbo orders this).
- `bun run brevi` at the repo root and a `bun link`ed `brevi` bin both execute the built `dist/`; rebuild before testing changes. `bun run dev` here is only `tsc --watch` (type checking, not a runnable build).
- `brevi update` self-updates from npm and restarts; be careful changing its process-management logic.
