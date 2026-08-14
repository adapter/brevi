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
- `bun run build:binary` (after `bun run build`) compiles brevi into a single-file standalone executable (`bun build --compile`) for the Linux worker installer; it needs the `@lydell/node-pty` plugin in `scripts/build-binary.ts` to statically require that platform's native addon, so it must be built natively per architecture, never cross-compiled.
- The hosted installer (`packages/worker/scripts/install.sh`) installs the standalone binary, bubblewrap (as root), and `brevi-worker.service`. Enrollment itself has no command of its own: the installer hands the pairing token to the daemon (`BREVI_TOKEN` in `/etc/brevi/worker.env`) and the daemon redeems it on its first connection.
- `brevi worker update` runs in two processes on purpose: replacing the executable does not replace the running one, so once the new binary lands the old process re-execs it with the hidden `--resume-after-binary` and stops. The new process restarts the systemd unit.
- `brevi setup` only installs bubblewrap on Linux (`apt install bubblewrap`) and probes unprivileged user namespaces. It is not what the installer uses to provision a worker.
