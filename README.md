# brevi

> [!WARNING]
> brevi is under active development. Expect breaking changes between releases, rough edges, and APIs that move without notice — pin exact versions if you depend on it.

A local sandbox and orchestrator for coding agents.

Connect your machine to Linear and GitHub, tag a ticket with **@brevi** (or the `brevi` label), and brevi picks it up:

- **SPIKE tickets** → runs a coding agent to research the question and posts the findings back to the Linear issue as a comment.
- **Implementation tickets** → runs a coding agent on a checkout of the mapped repo, pushes a branch, and opens a GitHub PR that includes a demo (screenshots or a screen recording) captured by the agent.

Every execution runs in an isolated sandbox. On Linux with KVM, sandboxes are [Firecracker](https://firecracker-microvm.github.io/) microVMs; elsewhere a local process sandbox is used for development.

## Quick start

```sh
npx @brevi/cli init   # pick a sandbox provider
npx @brevi/cli ui     # start the orchestrator and open the dashboard
```

`init` only picks a sandbox provider. Everything else happens in the dashboard's **Connections** panel with one-click **Connect** buttons — no copying keys:

- **GitHub** — uses your `gh` CLI login if present, or an OAuth device code (with `connect.githubClientId` configured).
- **Claude** — found on this machine: your Claude Code login (Keychain / `~/.claude`) or `ANTHROPIC_API_KEY`.
- **Codex** — found on this machine: `OPENAI_API_KEY` or the Codex CLI login (`~/.codex/auth.json`).
- **Linear** — browser OAuth (with `connect.linearClientId`/`Secret` configured), else a pasted API key.

Every credential is verified live before saving — agent keys with a 1-token probe on the provider's cheapest model (`claude-haiku-4-5` / `gpt-5-nano`) — and stored in `~/.brevi/config.json`. All brevi state lives under `~/.brevi/`; the orchestrator reads no environment variables. Manual key entry remains as a fallback on every provider. Then pick repositories straight from your GitHub account, assign yourself a Linear issue, and put `@brevi` in its title/description (or add the `brevi` label); add `SPIKE` for research-only tickets.

Other commands: `brevi start` (headless, no browser), `brevi status`.

## How it works

```
Linear (assigned issues tagged @brevi)
   │  poll
   ▼
orchestrator ──► classify: SPIKE │ implementation
   │
   ▼
sandbox (Firecracker microVM / process)
   │  git checkout of the mapped repo + coding agent (Claude Code, headless)
   ▼
implementation → branch + PR with demo artifacts      SPIKE → research comment on the issue
```

State lives in `~/.brevi/`: `config.json`, run history + artifacts under `runs/`, VM images under `images/`.

## Apps and packages

Only `@brevi/cli` is published — it bundles the workspace libraries into a single file and ships the dashboard's built assets. The rest are internal workspace packages.

| Package | What it is |
| --- | --- |
| `@brevi/cli` | **Published.** `brevi init` / `brevi ui` / `brevi start` / `brevi status`; bundles everything below |
| `@brevi/orchestrator` | Linear polling, run pipeline, GitHub PRs, HTTP/WS API, serves the dashboard |
| `@brevi/sandbox` | Sandbox providers: Firecracker microVMs (Linux + KVM) and local process fallback |
| `@brevi/shared` | Domain types, config schema (zod), dashboard API/WebSocket protocol |
| `@brevi/app` | The dashboard — Vite + React, shadcn/ui on Base UI, live run console, tickets, artifacts |
| `@brevi/docs` | Documentation site (Astro Starlight), deployed to [brevi.dev](https://brevi.dev) |
| `@brevi/api` | Hosted OAuth backend (Hono on Cloudflare Workers), deployed to api.brevi.dev |

## Development

Bun workspaces + Turborepo:

```sh
bun install
bun run build          # turbo run build (dependency-ordered)
bun run dev            # watch mode everywhere; dashboard dev server on :4401
bun run lint           # oxlint
bun run check-types
```

To run the CLI from the repo instead of the published package:

```sh
# either through the root script…
bun run brevi -- init
bun run brevi -- ui

# …or link it once and use `brevi` anywhere
cd packages/cli && bun link
brevi init
brevi ui
```

After changing CLI/orchestrator code, rerun `bun run build` — the linked bin runs the built `dist/`.

For Firecracker sandboxes you need a Linux host with `/dev/kvm`, a kernel image, and a rootfs — see `packages/sandbox/README.md` for the one-time image and network setup.

## CI, deploys, and releases

GitHub Actions on [Blacksmith](https://blacksmith.sh) runners (`.github/workflows/`):

- **`ci.yml`** — lint, typecheck, and build on every PR and push to main, then deploy the docs and the api to Cloudflare Workers:
  - Pull requests → the **preview** environment (`brevi-docs-preview` / `brevi-api-preview` on the account's `workers.dev` subdomain). Forked PRs skip deploys.
  - Pushes to main → **production** ([brevi.dev](https://brevi.dev) and api.brevi.dev, attached as custom domains).
- **`release.yml`** — releases `@brevi/cli` via [Changesets](https://github.com/changesets/changesets) and [npm staged publishing](https://docs.npmjs.com/staged-publishing). When main has pending changesets, the workflow opens (or updates) a **Release packages** PR; merging it **stages** the new version on npm. Nothing goes live until a maintainer approves the staged version with 2FA (npmjs.com → **Staged Packages**, or `npm stage approve <stage-id>`).

Releasing a change:

```sh
bun changeset        # describe the change, pick a bump — commit the generated file with your PR
# …merge the Release packages PR when it appears, then approve the staged versions on npmjs.com
```

The docs site's **Changelog** page is generated at build time from the packages' `CHANGELOG.md` files (`apps/docs/scripts/build-changelog.ts`), so each release lands in the published docs on the next main deploy.

Repository secrets the workflows need: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `NPM_TOKEN`. The api's own OAuth secrets are set per Worker environment with `wrangler secret put <NAME> --env production|preview` (see `apps/api/wrangler.jsonc`).
