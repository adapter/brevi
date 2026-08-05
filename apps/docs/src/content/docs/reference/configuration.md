---
title: Configuration
description: Every field in ~/.brevi/config.json — Linear, GitHub, repositories, agent, sandbox, connect, triggers and server settings.
---

brevi's entire configuration is one JSON file at **`~/.brevi/config.json`**. It is created by `brevi init` and then mostly written for you by the dashboard. The file is validated on load; an unknown shape or an out-of-range value makes brevi refuse to start rather than run with a surprise.

The orchestrator reads no environment variables for configuration.

## Defaults

A freshly initialised config, with every default filled in:

```json
{
  "linear": { "apiKey": "", "teamKeys": [] },
  "github": { "token": "", "prDescription": "concise" },
  "repos": {},
  "agent": {
    "command": "claude",
    "args": [],
    "anthropicApiKey": "",
    "claudeCodeOauthToken": "",
    "codexApiKey": "",
    "codexAuthJson": ""
  },
  "sandbox": {
    "provider": "auto",
    "firecracker": {
      "binary": "firecracker",
      "kernelImage": "~/.brevi/images/vmlinux",
      "rootfs": "~/.brevi/images/rootfs.ext4",
      "vcpus": 2,
      "memMib": 4096
    },
    "timeoutMinutes": 60
  },
  "connect": {
    "apiBase": "https://api.brevi.dev",
    "githubClientId": "",
    "linearClientId": "",
    "linearClientSecret": ""
  },
  "trigger": { "label": "brevi", "spikeMarker": "SPIKE" },
  "server": { "port": 4400 },
  "pollIntervalSeconds": 60
}
```

`kernelImage` and `rootfs` default to absolute paths inside your home directory; they are shown abbreviated here.

## `linear`

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `apiKey` | string | `""` | Personal API key or OAuth access token. Empty means not connected. Set it from the Connections rail. |
| `teamKeys` | string[] | `[]` | Restrict polling to these team keys, e.g. `["ENG"]`. Empty polls all teams you can see. |

Keys beginning with `lin_api_` are sent as a raw `Authorization` header; anything else is treated as an OAuth token and sent as `Bearer`.

## `github`

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `token` | string | `""` | Token with the `repo` scope. Used to list repos, clone, push, and open PRs. Empty means not connected. |
| `prDescription` | `"concise"` \| `"detailed"` | `"concise"` | How the agent is told to write the PR description: `concise` asks for a couple of sentences plus a few bullets, `detailed` allows a full write-up. |

Implementation tickets will not run without it. SPIKEs will.

## `repos` and `defaultRepo`

`repos` maps a **repo key** to a repository. The key is what tickets route on — a `repo:<key>` label, a bare label, or a Linear project name. The dashboard uses the repository name as the key when you add a repo.

```json
{
  "repos": {
    "brevi": {
      "remote": "adapter/brevi",
      "defaultBranch": "main",
      "projects": ["Brevi"]
    },
    "web": {
      "remote": "adapter/web",
      "defaultBranch": "main",
      "path": "/Users/you/code/web",
      "devCommand": "bun run dev",
      "devUrl": "http://localhost:3000"
    }
  },
  "defaultRepo": "brevi"
}
```

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `remote` | string | required | `"owner/name"`. Validated against that shape. |
| `defaultBranch` | string | `"main"` | Cloned from, and the base branch of the PR. |
| `projects` | string[] | `[]` | Linear project names whose tickets run against this repo. Matched case-insensitively; editable per repo in the dashboard's Connections panel. |
| `path` | string | – | Local checkout to clone from instead of the network. |
| `devCommand` | string | – | Command that starts a dev server; makes the agent capture Playwright screenshots for the demo. |
| `devUrl` | string | – | URL the dev server listens on, so the agent knows when it's up and what to screenshot. |

`defaultRepo` is the key used when a ticket matches no mapping. It must name an existing entry. If you clear it, brevi falls back to the first repo rather than stranding tickets.

## `agent`

The coding agent executed inside the sandbox.

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `command` | string | `"claude"` | The agent CLI to run inside the sandbox. |
| `args` | string[] | `[]` | Extra arguments appended after brevi's own. |
| `model` | string | – | Passed as `--model` when set. |
| `anthropicApiKey` | string | `""` | Exported into the sandbox as `ANTHROPIC_API_KEY`. |
| `claudeCodeOauthToken` | string | `""` | Claude Code login, exported as `CLAUDE_CODE_OAUTH_TOKEN`. |
| `codexApiKey` | string | `""` | Exported as `OPENAI_API_KEY`. |
| `codexAuthJson` | string | `""` | Whole contents of `~/.codex/auth.json` for a ChatGPT login; written into the sandbox and reached via `CODEX_HOME`. |

brevi always invokes the agent as `<command> -p <prompt> --output-format stream-json --verbose --dangerously-skip-permissions`, then `--model <model>` if set, then `args`. Those are Claude Code's flags, so a different `command` has to accept the same shape.

At least one of the four credential fields must be set or every run fails at startup with `no agent credentials configured`. Populate them with the Connections rail rather than by hand — the dashboard verifies keys before saving.

## `sandbox`

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `provider` | `"auto"` \| `"firecracker"` \| `"process"` | `"auto"` | See [Sandboxes](/guides/sandboxes/). |
| `timeoutMinutes` | integer ≥ 1 | `60` | Hard wall-clock limit for one run's agent command. |
| `firecracker` | object | see below | Only consulted when the Firecracker provider is used. |

### `sandbox.firecracker`

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `binary` | string | `"firecracker"` | Resolved on `PATH` unless it's an absolute path. |
| `kernelImage` | string | `~/.brevi/images/vmlinux` | Uncompressed Linux kernel. |
| `rootfs` | string | `~/.brevi/images/rootfs.ext4` | Ext4 image with node, git and the agent preinstalled. |
| `vcpus` | integer ≥ 1 | `2` | vCPUs per microVM. |
| `memMib` | integer ≥ 512 | `4096` | Memory per microVM, in MiB. |

## `connect`

Settings for the dashboard's one-click Connect flows. Leave the whole object at its defaults unless you self-host.

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `apiBase` | string | `"https://api.brevi.dev"` | Base URL of the hosted OAuth backend brevi uses when no personal OAuth app is configured. Point it at your own deployment of `apps/api` to self-host. |
| `githubClientId` | string | `""` | Your own GitHub OAuth app (device flow enabled). When set, brevi talks to GitHub directly. |
| `linearClientId` | string | `""` | Your own Linear OAuth app. Requires the secret below. |
| `linearClientSecret` | string | `""` | Secret for that app. Redacted whenever the config is sent to the dashboard. |

A self-hosted Linear OAuth app must register the redirect URI `http://localhost:<port>/api/connect/linear/callback` for the port in `server.port`. See [Connections](/guides/connections/).

## `trigger`

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `label` | string | `"brevi"` | Label that opts a ticket in. Matched case-insensitively. |
| `spikeMarker` | string | `"SPIKE"` | Marks a ticket as research-only when it appears in the title or in a label. Case-insensitive. |

## `server`

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `port` | integer | `4400` | The orchestrator binds `127.0.0.1` on this port and serves both the API and the dashboard. |

## `pollIntervalSeconds`

Integer, minimum `10`, default `60`. How often brevi polls Linear for eligible tickets. brevi also polls immediately at startup and whenever Linear or the repo mappings change.

## Redaction

When the config is read back over the API or the WebSocket, `linear.apiKey`, `github.token`, all four `agent` credential fields, and `connect.linearClientSecret` are replaced with `"***"`. Empty strings stay empty so the dashboard can distinguish "not connected" from "connected".
