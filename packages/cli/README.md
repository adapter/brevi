# @brevi/cli

The brevi command line — a local sandbox and orchestrator for coding agents. Add the `brevi` label to a Linear ticket, get back a pull request.

```sh
npx @brevi/cli init   # create ~/.brevi/config.json, pick a sandbox provider
npx @brevi/cli ui     # start the orchestrator and open the dashboard
```

Or install globally for the `brevi` binary:

```sh
npm install -g @brevi/cli
```

## Commands

| Command | What it does |
| --- | --- |
| `brevi init` | Create the config and choose a sandbox provider (`auto` / `firecracker` / `process`) |
| `brevi ui` | Start the orchestrator and open the dashboard in your browser |
| `brevi start` | Start headless (no browser) |
| `brevi status` | Show orchestrator health and recent runs |

Everything else — connecting Linear, GitHub, and agent credentials, mapping repositories — happens in the dashboard's Connections panel. All state lives under `~/.brevi/`.

Docs: [brevi.dev](https://brevi.dev) · Source: [github.com/adapter/brevi](https://github.com/adapter/brevi)
