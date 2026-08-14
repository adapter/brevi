# @brevi/cli

The published `brevi` command line (bin: `dist/index.js`). Thin layer over `@brevi/orchestrator`: parses commands with commander, starts the orchestrator, opens the dashboard. First launch writes schema defaults and lands on `/setup`; on Linux it also provisions Firecracker.

## Layout

- `src/index.ts`: entry point and command registration
- `src/commands/`: one file per command (`default`/`ui`, `start`, `status`, `update`; `setup` is hidden for the installer; `init` is a hidden removal stub)
- `src/lib/`: prompt helpers (@clack/prompts), config discovery, update logic

## Gotchas

- `bun run build` bundles with `bun build` and copies the dashboard build into `dist/app` from `../../apps/app/dist`, so `apps/app` must be built first (turbo orders this).
- `bun run brevi` at the repo root and a `bun link`ed `brevi` bin both execute the built `dist/`; rebuild before testing changes. `bun run dev` here is only `tsc --watch` (type checking, not a runnable build).
- `brevi update` self-updates from npm and restarts; be careful changing its process-management logic.
- `bun run build:binary` (after `bun run build`) compiles brevi into a single-file standalone executable (`bun build --compile`) for the Linux worker installer; it needs the `@lydell/node-pty` plugin in `scripts/build-binary.ts` to statically require that platform's native addon, so it must be built natively per architecture, never cross-compiled.
- `brevi setup --yes --skip-network --set-provider` and `brevi worker update` are what the hosted installer (`packages/worker/scripts/install.sh`) calls to provision a freshly built machine and to keep an installed worker's binary and rootfs image current in place. Enrollment itself has no command of its own: the installer hands the pairing token to the daemon (`BREVI_TOKEN` in `/etc/brevi/worker.env`) and the daemon redeems it on its first connection.
- `brevi worker update` runs in two processes on purpose: replacing the executable does not replace the running one, so once the new binary lands the old process re-execs it with the hidden `--resume-after-binary` and stops. Everything after the swap (which rootfs image the release wants, whether its manifest is acceptable, the service restart) has to be decided by the release being installed, or a release that bumps `ROOTFS_VERSION` leaves the machine with a new binary and no image it will accept.
- `sudo brevi worker update` on a machine with the installed unit resolves the `brevi` service user's own `~/.brevi` (via `getent passwd`) and passes those paths explicitly to `loadConfig`/`locateRootfs`/`installRootfs`, then chowns what it downloaded. The module-level path constants in `@brevi/shared` derive from `homedir()`, so relying on them there would put a multi-gigabyte rootfs in root's home, where the daemon never looks.
