---
title: Configuration
description: "Every field in ~/.brevi/config.json: Linear, GitHub, repositories, agent, sandbox, connect, triggers and server settings."
---

brevi's entire configuration is one JSON file at **`~/.brevi/config.json`**. It is created by `brevi init` and then written for you by the dashboard. The file is validated on load; an unknown shape or an out-of-range value makes brevi refuse to start rather than run with a surprise.

The orchestrator reads no environment variables for configuration.

## Editing it

Every field on this page is editable from the dashboard's Configuration page, at `/config`:

| Page | Covers |
| --- | --- |
| Connectors | Connect/Disconnect per provider, `linear.teamKeys`, `github.prDescription`, `r2` |
| Repositories | `repos`, `defaultRepo` |
| Agent | `agent` (models, effort, command, args, Codex review) |
| Sandbox | `sandbox`, including the Firecracker fields |
| Memory | `memory`, plus the stored memories themselves |
| Orchestrator | `trigger`, `pollIntervalSeconds`, `restart` |
| Server | `server`, `connect` |

Each card is saved explicitly, and a save sends only the fields on that card: nothing else in the file is rewritten, so two tabs (or a tab and your editor) cannot clobber each other. Fields with a non-empty default show it as placeholder text and offer a reset once the value differs from it. Invalid input is rejected with the same message the schema would produce, and the file on disk is never left invalid: it is validated in full, then replaced atomically (and left readable only by you).

Almost everything applies to the next run without a restart. Three fields are read once at startup and are marked with a **restart** badge in the UI: `server.port`, `server.host`, and `sandbox.provider`.

Two groups of fields are deliberately not editable there:

- **Credentials.** They are masked whenever the config is read back (see [Redaction](#redaction)), so they are never rendered as editable values; use the Connect and Disconnect buttons instead. `connect.linearClientSecret` is the one write-only field: it can be replaced, never read back. `linear.refreshToken` and `linear.tokenExpiresAt` are owned by the OAuth flow.
- **`sandbox.firecracker.vcpus` and `memMib`.** When either is set, the Sandbox page shows the resulting allocation read-only with the override named, plus a button that clears both so the size preset applies again.

Hand edits keep working. The file stays the source of truth in both directions: brevi watches it and picks up an external edit without a restart, and the dashboard updates by itself. An edit that fails validation is logged and ignored, leaving the running settings alone.

## Defaults

A freshly initialised config, with every default filled in:

```json
{
  "linear": { "apiKey": "", "refreshToken": "", "tokenExpiresAt": "", "teamKeys": [] },
  "github": { "token": "", "prDescription": "concise" },
  "r2": { "bucket": "", "publicBaseUrl": "" },
  "repos": {},
  "agent": {
    "command": "claude",
    "args": [],
    "orchestratorModel": "claude-fable-5",
    "implementModel": "claude-sonnet-5",
    "orchestratorEffort": "high",
    "anthropicApiKey": "",
    "claudeCodeOauthToken": "",
    "codexApiKey": "",
    "codexAuthJson": "",
    "codexReview": true,
    "reviewModel": "gpt-5.6-sol",
    "reviewEffort": "high"
  },
  "memory": { "enabled": true, "maxEntries": 60, "maxChars": 8000 },
  "sandbox": {
    "provider": "auto",
    "concurrency": 1,
    "firecracker": {
      "binary": "firecracker",
      "kernelImage": "",
      "rootfs": "",
      "rootfsBaseUrl": "https://images.brevi.dev/rootfs",
      "size": "medium"
    },
    "timeoutMinutes": 60,
    "retentionHours": 24
  },
  "connect": {
    "apiBase": "https://api.brevi.dev",
    "githubClientId": "",
    "linearClientId": "",
    "linearClientSecret": ""
  },
  "trigger": { "label": "brevi" },
  "restart": { "auto": true, "maxAttempts": 5, "probeIntervalMinutes": 15 },
  "server": { "port": 4400, "host": "127.0.0.1" },
  "pollIntervalSeconds": 60
}
```

`kernelImage` and `rootfs` are empty by default, which means "the images brevi manages" under `~/.brevi/images/`; set either to point at your own.

## `linear`

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `apiKey` | string | `""` | Personal API key or OAuth access token. Empty means not connected. Set it from the dashboard's Configuration page. |
| `refreshToken` | string | `""` | OAuth refresh token captured by the Connect flow, used to rotate an expiring `apiKey` automatically. Empty for plain `lin_api_` keys, which never expire. |
| `tokenExpiresAt` | string | `""` | ISO timestamp the OAuth access token expires at. Empty when unknown (plain API keys, or before the first refresh). |
| `teamKeys` | string[] | `[]` | Restrict polling to these team keys, e.g. `["ENG"]`. Empty polls all teams you can see. |

Keys beginning with `lin_api_` are sent as a raw `Authorization` header; anything else is treated as an OAuth token and sent as `Bearer`.

## `github`

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `token` | string | `""` | Token with the `repo` and `workflow` scopes. Used to list repos, clone, push, and open PRs. Empty means not connected. |
| `prDescription` | `"concise"` \| `"detailed"` | `"concise"` | How the agent is told to write the PR description: `concise` asks for a couple of sentences plus a few bullets, `detailed` allows a full write-up. |

Tickets will not run without it: every run pushes a branch and opens a pull request.

## `r2`

Optional. When both fields are set, demo evidence (screenshots and recordings) from successful runs is uploaded to a public Cloudflare R2 bucket and embedded in the PR description.

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `bucket` | string | `""` | Public R2 bucket evidence is uploaded to. Empty means uploads are disabled. Trimmed on load. |
| `publicBaseUrl` | string | `""` | Public base URL the bucket serves from: its r2.dev development URL, or a custom domain. Used verbatim to build the asset links embedded in PR descriptions, so it is trimmed and stripped of trailing slashes on load. |

There is no credential field here. Authentication goes through the host's `wrangler` CLI, the same one you use for any other Cloudflare work: `wrangler login` for auth, `wrangler r2 object put` for the upload. Connect and configure both fields from the dashboard's Configuration page; see [Connections](/guides/connections/).

At the end of a successful run, once artifacts are collected on the host, each screenshot (`png`/`jpg`) and recording (`webm`/`mp4`/`mov`/`gif`) is uploaded to `<bucket>/<runId>/<name>`, keyed by run id so names never collide across runs. Uploads are strictly best-effort: a failure is logged in the run's console and never fails the run. If wrangler is logged out, missing, or either field is unset, runs behave exactly as before and evidence stays local.

Connecting from the dashboard provisions both fields automatically: it creates the `brevi-evidence` bucket and enables its r2.dev development URL. A bucket that already exists is reused only when it is already public (as a previous brevi setup's would be); brevi never enables public access on a bucket it did not create, so that case fails with instructions instead. Edit the fields by hand only if you want a different bucket name or a custom domain.

:::caution
The bucket is public: anyone with a URL can view any screenshot or recording brevi has uploaded, which may include your codebase or product. Leave both fields empty to keep all evidence local.

brevi also never deletes uploaded objects. Clean them up yourself, or attach an R2 lifecycle rule to expire old objects automatically.
:::

## `repos` and `defaultRepo`

`repos` maps a **repo key** to a repository. The key is what tickets route on: a `repo:<key>` label, a bare label, or a Linear project name. The dashboard uses the repository name as the key when you add a repo.

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
| `projects` | string[] | `[]` | Linear project names whose tickets run against this repo. Matched case-insensitively; editable per repo on the dashboard's Configuration page. |
| `path` | string | - | Local checkout to clone from instead of the network. |
| `devCommand` | string | - | Command that starts a dev server; makes the agent capture Playwright screenshots for the demo. |
| `devUrl` | string | - | URL the dev server listens on, so the agent knows when it's up and what to screenshot. |
| `demo` | `"always"` \| `"auto"` \| `"never"` | `"auto"` | How much demo evidence runs capture. `always` is the full dev-server/screenshot flow; `auto` lets the agent downgrade to test output or a CLI transcript for changes with no visible surface (docs, tests, refactors); `never` skips the demo requirement. |

`defaultRepo` is the key used when a ticket matches no mapping. It must name an existing entry, or the config is rejected; leave it unset and unmatched tickets simply don't run. Removing a repo from the dashboard clears `defaultRepo` along with it when it pointed there.

## `agent`

The coding agent executed inside the sandbox.

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `command` | string | `"claude"` | The agent CLI brevi runs. It must be available where the run executes: on the host's `PATH` under the process provider, baked into the rootfs image under Firecracker. |
| `args` | string[] | `[]` | Extra arguments appended after brevi's own. |
| `model` | string | - | When set, the whole run uses this one model with no subagent delegation, overriding `orchestratorModel` and `implementModel`. |
| `orchestratorModel` | string | `"claude-fable-5"` | Model the main agent loop runs on (planning, review, delegation). Claude agents only. |
| `implementModel` | string | `"claude-sonnet-5"` | Model for the `implementer` subagent that executes the coding tasks. Claude agents only. |
| `orchestratorEffort` | `"low"` \| `"medium"` \| `"high"` | `"high"` | Reasoning effort for the main agent loop, passed to Claude Code as `--effort`. Claude agents only; the `implementer` subagent keeps the CLI's default effort. |
| `anthropicApiKey` | string | `""` | Exported into the sandbox as `ANTHROPIC_API_KEY`. |
| `claudeCodeOauthToken` | string | `""` | Claude Code login, exported as `CLAUDE_CODE_OAUTH_TOKEN`. |
| `codexApiKey` | string | `""` | Exported as `OPENAI_API_KEY`. |
| `codexAuthJson` | string | `""` | Whole contents of `~/.codex/auth.json` for a ChatGPT login; written into the sandbox and reached via `CODEX_HOME`. |
| `codexReview` | boolean | `true` | Whether an adversarial Codex review runs after the implementation pass. Claude-primary runs only: when `command` is already Codex the review is skipped, so a run never reviews itself with its own provider. Also requires a Codex credential (`codexApiKey` or `codexAuthJson`); without one the review is skipped even when true. See [Codex review](#codex-review) below. |
| `reviewModel` | string | `"gpt-5.6-sol"` | Model the Codex review runs on. |
| `reviewEffort` | `"minimal"` \| `"low"` \| `"medium"` \| `"high"` | `"high"` | Reasoning effort for Codex review executions, passed as `-c model_reasoning_effort=<value>`. |

brevi always invokes the agent as `<command> -p <prompt> --output-format stream-json --verbose --permission-mode auto`, then `--model <model>`, then `args`. Those are Claude Code's flags, so a different `command` has to accept the same shape. Claude agents additionally get `--effort <orchestratorEffort>`. Auto mode runs without permission prompts while a classifier blocks actions that escalate beyond the ticket (such as exfiltrating data); it needs a model that supports it, which every default brevi model does.

Claude runs are a single agent session with delegation: the main loop runs on `orchestratorModel` and dispatches the coding work to an `implementer` subagent on `implementModel` (defined via Claude Code's `--agents` flag). Setting `model` disables delegation and runs everything on that one model. Commands containing `codex` always run single-model on `model`.

### Codex review

When `codexReview` is true, the primary agent is Claude, and a Codex credential is configured, an adversarial Codex review runs inside the same sandbox after the implementation pass finishes its coding phase and before the branch is pushed. The review is deliberately a cross-provider check: runs whose `command` is already Codex skip it (a console line notes the skip), so enabling it never multiplies a Codex-primary run's spend. Three Codex reviewers (`codex exec`) run in parallel, each taking one angle: requirements coverage against the ticket, a bug hunt on the diff, and regression risk in the call sites the diff touches. All three judge the uncommitted diff against two sources of truth: the Linear ticket text and the existing codebase. A synthesis pass then verifies, dedupes, and ranks the findings into `.brevi/review.md`, kept with the run's artifacts. Confirmed findings are fed back to the Claude orchestrator for a fix pass before the PR opens.

Without a Codex credential the review is likewise skipped cleanly and the run behaves exactly as before. The review roughly doubles the agent spend of a run; set `codexReview: false` to turn it off. Review executions appear in the run's cost breakdown as "review (requirements)", "review (bugs)", "review (regressions)", "review (synthesis)", and the fix pass as "review fixes".

Under the Firecracker provider, the review runs the Codex CLI inside the sandbox, so an existing host on an older rootfs image needs the current image before the review can run: brevi downloads the current prebuilt image automatically (`brevi setup`, or on demand at startup); from-source setups instead rebuild with `packages/sandbox/scripts/build-rootfs.sh`. Under the process provider the host's `codex` binary is used directly.

Live per-model cost sampling during Claude runs likewise needs `ccusage` in the rootfs image under the Firecracker provider: hosts on an older image get it the same way, by downloading the current prebuilt image (or rebuilding from source). Without it, runs still work and cost falls back to today's end-of-run, stream-parsed behavior.

At least one of the four credential fields (`anthropicApiKey`, `claudeCodeOauthToken`, `codexApiKey`, `codexAuthJson`) must be set or every run fails at startup with `no agent credentials configured`. Populate them from the dashboard's Configuration page rather than by hand; the dashboard verifies keys before saving.

## `memory`

What brevi carries from one run to the next. Every run executes in a throwaway sandbox against a fresh checkout, so anything the agent worked out about a repository (which command actually builds it, where a concern lives, which trap cost it twenty minutes) would die with the sandbox and be rediscovered, at full token price, by the next ticket. Memories are the exception: durable facts a run records on its way out, kept on the host under `~/.brevi/memories/`, one JSON file per repository.

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Inject stored memories into run prompts and harvest new ones afterwards. Off means every run starts cold. |
| `maxEntries` | integer 1-500 | `60` | How many memories are kept per repo. Once full, the least recently recorded ones are dropped. |
| `maxChars` | integer 200-50000 | `8000` | Character budget for the memories block injected into a prompt. Memories past the budget are left out of that run. |

A run reads the repo's memories before the agent starts and adds a `## Repository memories` section to the prompt, next to the repository map. On the way out it reads `.brevi/memories.md`, the file the agent is asked to leave behind, and merges what it finds: a fact that is already known is reaffirmed rather than duplicated, and the repo is trimmed back to `maxEntries`. Follow-up runs do both too. The harvest happens before the branch is committed, so a run that ends with `agent made no changes` still contributes what it learned.

Memories are keyed by the repository's remote (`owner/name`), not by the mapping key that resolved it, so repointing or reusing a `repos` key never hands the next run another repository's facts. They are never global, and they never reach the sandbox as files: they exist only inside the prompt. Nothing is retrieved semantically; the most recently confirmed entries are injected verbatim until the budget runs out.

A wrong memory is worse than no memory, because every later run in that repo is handed it. The Memory page lists everything stored, with the ticket that recorded each fact and how many runs have confirmed it, and drops one (or a whole repo) on click. `memories.md` is also kept with the run's artifacts, so you can see what a given run contributed.

## `sandbox`

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `provider` | `"auto"` \| `"firecracker"` \| `"process"` | `"auto"` | See [Sandboxes](/guides/sandboxes/). |
| `concurrency` | integer 1-16 | `1` | How many sandboxed runs execute at once. Each Firecracker microVM reserves its own memory (7.5 GB for the default `medium` size preset, see `firecracker.size`) and one tap device from the pool created by [the network setup script](/guides/sandboxes/) (16 by default), so the host needs enough of both for all of them running simultaneously. Adjustable live from the dashboard; takes effect immediately, no restart needed. |
| `timeoutMinutes` | integer ≥ 1 | `60` | Hard wall-clock limit applied per agent execution: the implementation pass, each of the parallel Codex reviewers, the synthesis pass, and the fix pass each get their own budget, rather than one limit for the whole run. |
| `retentionHours` | number ≥ 0 | `24` | How many hours a finished (completed or failed) run's sandbox disk is kept for interactive resume, either from the dashboard's "Open terminal" button or `brevi attach <runId>`. `0` disables retention. A retained sandbox's compute is stopped; it costs disk only, no memory or CPU. |
| `firecracker` | object | see below | Only consulted when the Firecracker provider is used. |

### `sandbox.firecracker`

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `binary` | string | `"firecracker"` | Resolved on `PATH` unless it's an absolute path. |
| `kernelImage` | string | `""` | Uncompressed Linux kernel. Empty resolves to `~/.brevi/images/vmlinux`, the image `brevi setup` downloads. |
| `rootfs` | string | `""` | Ext4 image with node, git, both agent CLIs (`@anthropic-ai/claude-code`, `@openai/codex`), and `ccusage` preinstalled. Empty means brevi manages it: a from-source build at `~/.brevi/images/rootfs.ext4` (`build-rootfs.sh`) wins, and when there's no valid image there brevi falls back to the versioned cache under `~/.brevi/cache/rootfs/`, downloading a checksum-verified image on demand. A path set here is used as-is and is never downloaded or built over. An image that's empty, corrupt, or whose manifest version doesn't match brevi's fails preflight until it's rebuilt or redownloaded. |
| `rootfsBaseUrl` | string | `"https://images.brevi.dev/rootfs"` | Base URL prebuilt rootfs images are downloaded from. Point it at a mirror for self-hosted or air-gapped setups. |
| `size` | `"small"` \| `"medium"` \| `"large"` | `"medium"` | VM size preset: `small` (1 vCPU, 3.75 GB), `medium` (2 vCPU, 7.5 GB), `large` (4 vCPU, 15 GB). Selectable live from the dashboard's Sandbox page (Configuration > Sandbox) when the active provider is Firecracker; a change applies to newly booted VMs only, running VMs are untouched. |
| `vcpus` | integer ≥ 1 | unset | Explicit vCPU override. Wins over `size` when set; existing config files with an explicit value keep their exact behavior. Picking a preset in the dashboard clears it. |
| `memMib` | integer ≥ 512 | unset | Explicit memory override, in MiB. Wins over `size` when set; existing config files with an explicit value keep their exact behavior. Picking a preset in the dashboard clears it. |

A config file from before size presets that sets only one of `vcpus`/`memMib` (and no `size`) keeps the old default for the other (2 vCPUs, 4096 MiB): the preset never changes an allocation such a config was already getting.

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

## `restart`

What happens when the agent hits a provider usage limit mid-run. Instead of failing the run, brevi parks it as `waiting` and starts a fresh attempt once the limit lifts.

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `auto` | boolean | `true` | Automatically wait out agent usage limits and start a new attempt. With it off, a limited run fails immediately. |
| `maxAttempts` | integer ≥ 1 | `5` | Cap on agent executions per run, counting the first. |
| `probeIntervalMinutes` | integer ≥ 1 | `15` | Minutes between liveness probes while waiting on a limit whose reset time the agent didn't report, and after a probe that is still limited. |

## `server`

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `port` | integer 1-65535 | `4400` | The orchestrator serves both the API and the dashboard on this port. |
| `host` | string | `"127.0.0.1"` | Bind address. The default keeps the dashboard reachable only from the machine itself; set `"0.0.0.0"` to reach it from other devices on the network. Prefer `"0.0.0.0"` over a specific interface address: loopback stays bound too, so `brevi status` and `brevi stop` keep working. **The dashboard and API have no authentication**, so anyone who can reach the port has full control of brevi, including a shell into its sandboxes; only expose it on networks you trust. |

## `pollIntervalSeconds`

Integer, minimum `10`, default `60`. How often brevi polls Linear for eligible tickets. brevi also polls immediately at startup and whenever Linear, the trigger label, or the repo mappings change.

## Redaction

When the config is read back over the API or the WebSocket, `linear.apiKey`, `linear.refreshToken`, `github.token`, all four `agent` credential fields, and `connect.linearClientSecret` are replaced with `"***"`. Empty strings stay empty so the dashboard can distinguish "not connected" from "connected".
