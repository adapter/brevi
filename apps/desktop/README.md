# @brevi/desktop

Mission Control as a desktop app: an Electron shell that starts, supervises, and displays the brevi orchestrator, so a terminal is never required. It loads the same dashboard (`@brevi/app`) straight from the embedded orchestrator's own server; there's no separate UI to keep in sync.

Interchangeable with the CLI: both read and write the same `~/.brevi/config.json`, the same run history, and the same server. If an orchestrator is already running (started with `brevi` in a terminal), the app attaches to it instead of starting a second one and leaves it running when it quits; `brevi status` sees an app-managed orchestrator as running too.

## Development

```sh
bun run build   # bundle src/main/index.ts to dist/main.js with bun
bun run start   # build, then launch (macOS runs a local brevi.app so the menu bar is not "Electron")
```

The app supervises the *built* CLI (`packages/cli/dist/index.js`), so `bun run build` at the repo root must have run first. Set `BREVI_DESKTOP_CLI_ENTRY` to point at a different entry during development.

## Packaging

```sh
bun run package   # electron-builder, macOS and Linux distributables
```

Not wired into CI: the Electron GUI needs system GTK/X11 libraries a headless runner doesn't have, so CI only lints, type-checks, and builds this workspace.

## Targets

macOS and Linux only. Windows is out of scope for the whole project.

Docs: [brevi.dev](https://brevi.dev) · Source: [github.com/adapter/brevi](https://github.com/adapter/brevi)
