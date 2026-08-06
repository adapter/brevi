# @brevi/cli

[![npm](https://img.shields.io/npm/v/%40brevi%2Fcli)](https://www.npmjs.com/package/@brevi/cli)

The brevi command line: a local sandbox and orchestrator for coding agents. Add the `brevi` label to a Linear ticket, get back a pull request.

```sh
npx @brevi/cli   # first run: pick a sandbox provider, then the dashboard opens
```

Or install globally for the `brevi` binary:

```sh
npm install -g @brevi/cli
```

## Commands

| Command | What it does |
| --- | --- |
| `brevi` | Start the orchestrator and open the dashboard; runs init first on a fresh machine |
| `brevi init` | Create the config and choose a sandbox provider (`auto` / `firecracker` / `process`) |
| `brevi start` | Start headless (no browser) |
| `brevi status` | Show orchestrator health and recent runs |
| `brevi update` | Update the installed CLI to the latest release on npm (`--check` to only report) |

Everything else (connecting Linear, GitHub, and agent credentials, mapping repositories) happens in the dashboard's Connections panel. All state lives under `~/.brevi/`.

Docs: [brevi.dev](https://brevi.dev) · Source: [github.com/adapter/brevi](https://github.com/adapter/brevi)
