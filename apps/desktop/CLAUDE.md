# @brevi/desktop

Mission Control as a desktop app. An Electron main process that owns and supervises the `@brevi/cli` orchestrator as a child process and points a single `BrowserWindow` at its dashboard; there is no renderer app and no preload script beyond a small offline status page, so the window shows exactly what a browser would.

## Layout (src/main)

- `index.ts`: entry point; the single-instance lock, wires supervisor/fleet/tray/window together, and the `before-quit` teardown sequence
- `supervisor.ts`: `OrchestratorSupervisor`, spawns `brevi start` as a child (Electron's own binary in Node mode, `ELECTRON_RUN_AS_NODE=1`) or attaches to an orchestrator already running, restarts on crash with capped backoff, SIGTERM-then-SIGKILL on stop
- `fleet.ts`: `FleetMonitor`, watches the orchestrator's `/ws` endpoint from the main process so the tray tracks runs without a dashboard window open, reconnects with backoff
- `tray.ts`: `FleetTray`, the tray/menu-bar icon, tooltip, and context menu (fleet status, recent runs, restart/quit/Start at Login)
- `window.ts`: `MissionControl`, the single `BrowserWindow`; shows the local status page or the dashboard, closing hides it rather than quitting, external links open in the system browser
- `notifications.ts`: native notification when a run completes or fails; clicking opens that run's page in the window
- `summary.ts`: pure formatting helpers (fleet counts, tray title/tooltip lines, run labels) shared by `tray.ts` and `index.ts`; kept free of the `electron` import so it's unit-testable under bun
- `autostart.ts`: "Start at Login" toggle: an Electron login item on macOS, an XDG autostart `.desktop` file on Linux (Windows is out of scope)
- `health.ts`: probes the orchestrator's `/api/health` and waits for it to come up
- `config.ts`: ensures `~/.brevi/config.json` exists, writing schema defaults on first launch and reporting whether that was a genuinely first launch
- `paths.ts`: resolves the `@brevi/cli` entry the app supervises (packaged build vs. repo checkout, or the `BREVI_DESKTOP_CLI_ENTRY` override) and the shared orchestrator log path
- `backoff.ts`: the restart delay schedule and attempt cap after consecutive orchestrator crashes
- `updater.ts`: electron-updater wiring; checks a static generic feed 30 seconds after launch and every 6 hours, downloads a new version, and restarts into it as soon as no run is executing locally; `beforeInstall` runs the app's normal quit teardown first so the supervised orchestrator is stopped before the new version starts its own
- `update-policy.ts`: pure decision logic (is updating even supported here, tray line and menu label per state, whether it's safe to install now); no `electron` import, so it's unit tested under bun like `summary.ts`
- `update-state.ts`: the only file the desktop app writes under `~/.brevi` (`~/.brevi/desktop-update.json`): which version an install was attempted for, how many times, and which versions are quarantined after failing twice. Config and run-history schemas stay owned by the orchestrator
- `src/renderer/status.html`: the only renderer file, a dependency-free "starting.../error" page loaded with `loadFile` before the orchestrator answers, so it renders with no server up. The build copies it to `dist/status.html`, which is where `index.ts` resolves it from in both a checkout and a packaged app
- `scripts/stage-cli.ts`: builds `build/cli`, the self-contained copy of `@brevi/cli` that `electron-builder` bundles as `extraResources`

## Gotchas

- The app supervises the *built* CLI (`packages/cli/dist/index.js`); run `bun run build` at the repo root first, or nothing starts. `BREVI_DESKTOP_CLI_ENTRY` overrides the resolved path for development (see `paths.ts`).
- `supervisor.ts` sets `BREVI_SUPERVISOR_PID` (its own pid) in the child's env when it spawns the CLI; `runServer` in `packages/cli/src/lib/serve.ts` reads it to record `owner: "desktop"` in the pid file instead of `"cli"`, so `brevi stop`/`brevi update` can tell a desktop-supervised server apart from one started at a terminal.
- bun does not run electron's postinstall unless the package is a trusted dependency; that's why the root `package.json` lists `trustedDependencies: ["electron"]`. Without it `electron .` has no binary to run.
- The Electron GUI needs system GTK/X11 libraries; headless CI machines cannot launch a window. CI lints, type-checks and builds this workspace, and packages an unpacked Linux build as a smoke check, but never launches the app; run it locally to actually see it.
- Packaging is `bun run package` (local, host arch) or `bun run package:mac` / `bun run package:linux` (what CI runs, one per target); all stage the CLI first and none of them publishes, uploading to the GitHub release and the R2 update feed is `desktop-release.yml`'s job, triggered by a `@brevi/cli` version bump landing on main rather than by a tag. The staged tree mirrors a production npm install (`package.json` at the root, the bundle under `dist/`, dependencies under `node_modules/`) because `readPackageVersion` in the CLI resolves `../package.json` relative to its entry file; flattening it silently degrades `brevi --version` to `0.0.0`.
- The staged CLI carries the host's own build of the native `@lydell/node-pty`, so a Linux artifact is only valid for the OS and architecture it was packaged on; that is why `.github/workflows/desktop-release.yml` has one runner per Linux target rather than cross-building. The macOS build is the exception: it is universal, merging both arches into one bundle. The binary is a Node-API addon, so it loads fine under `ELECTRON_RUN_AS_NODE=1` with no rebuild.
- Same state as the CLI on purpose: `~/.brevi/config.json`, run history, port, and `~/.brevi/server.pid` are shared, which is how `supervisor.ts` attaches to an orchestrator the CLI already started instead of running a second one.
- Auto-update only works for the macOS .app and the Linux AppImage. A deb or rpm install is owned by the package manager, so the app detects it (`process.env.APPIMAGE` is unset) and disables update checks instead of offering an update it cannot apply.
- The packaged app's version is injected from `packages/cli/package.json` (`-c.extraMetadata.version`), so `app.getVersion()` in a checkout and in a packaged build are different things.
- The macOS build is universal, which is why `scripts/stage-cli.ts --darwin-universal` fetches both `@lydell/node-pty-darwin-*` packages: the two arch app bundles being merged must carry identical, both-arch-capable resources.
- A failed update is self-healing rather than reversible: electron-updater only swaps the app in on success, so the previous version keeps running, and `update-state.ts` quarantines a version after two failed attempts.
- Tests: `bun test apps/desktop`. Keep modules that don't need `electron` (`summary.ts`, `backoff.ts`, `health.ts`, `update-policy.ts`) free of that import so they stay testable under plain bun.
