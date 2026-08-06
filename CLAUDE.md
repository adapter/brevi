# brevi

A local sandbox and orchestrator for coding agents: label a Linear ticket `brevi`, get back a GitHub PR (implementation tickets) or a research comment on the issue (SPIKE tickets). Runs execute in Firecracker microVMs (isolated) on Linux with KVM; elsewhere a process provider is used as a fallback, which provides no isolation (commands run directly on the host as the current user).

## Workspaces

Bun workspaces + Turborepo. Each workspace has its own CLAUDE.md with details.

| Workspace | What it is |
| --- | --- |
| `packages/cli` | The `brevi` command line (published entry point, `npx @brevi/cli`) |
| `packages/orchestrator` | The engine: polls Linear, runs agents in sandboxes, opens PRs, serves the dashboard |
| `packages/sandbox` | Sandbox providers (`firecracker`, `process`) behind one interface |
| `packages/shared` | Domain types, zod config schema for `~/.brevi/config.json`, dashboard protocol types |
| `packages/typescript-config` | Internal shared tsconfig (strict NodeNext baseline) |
| `apps/app` | The dashboard (Vite + React 19); built `dist/` is served by the orchestrator |
| `apps/api` | Hosted OAuth backend at api.brevi.dev (Hono on Cloudflare Workers) |
| `apps/docs` | Documentation site at brevi.dev (Astro + Starlight) |

## Commands

```sh
bun install
bun run build           # turbo, dependency-ordered
bun run dev             # watch mode everywhere; dashboard dev server on :4401
bun run lint            # oxlint
bun run check-types
bun run brevi -- <cmd>  # run the CLI from the repo (executes the built dist/)
```

## Rules and gotchas

- Never use em dashes (U+2014) in any file or generated text; CI fails on them everywhere except CHANGELOG.md files. Use a comma, colon, parentheses, or split the sentence.
- The CLI and the linked `brevi` bin execute built output: rerun `bun run build` after changing CLI/orchestrator code before testing via `bun run brevi`.
- All runtime state lives under `~/.brevi/` (config at `~/.brevi/config.json`). The orchestrator reads no environment variables for persistent configuration; the one exception is credential discovery in the Connect flow (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`).
- Commit/PR title convention: `PD-<n>: <description>` (Linear ticket ID first).
- Releases use changesets (`bun run changeset`); `bun run release` builds and stages publishing. Only `@brevi/cli` is published; the other workspaces are `private: true` and get bundled into its `dist/`. Every PR must include a changeset, enforced by the "Changeset present" CI status check: a `@brevi/cli` entry when a change in any bundled workspace (`orchestrator`, `sandbox`, `shared`, `app`) affects what ships, or an empty one (`bun run changeset --empty`) when there is nothing to release (docs site, api, CI). Keep the changeset message between 140 and 160 characters: one sentence on the user-visible change, no implementation detail.
- CI (`.github/workflows/ci.yml`) runs lint, check-types, build, and the em-dash check on every PR.
