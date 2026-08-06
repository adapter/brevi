# brevi

A local sandbox and orchestrator for coding agents: label a Linear ticket `brevi`, get back a GitHub PR (implementation tickets) or a research comment on the issue (SPIKE tickets). Runs are executed in isolated sandboxes (Firecracker microVMs on Linux with KVM, a process sandbox elsewhere).

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
- All runtime state lives under `~/.brevi/` (config at `~/.brevi/config.json`). The orchestrator reads no environment variables.
- Commit/PR title convention: `PD-<n>: <description>` (Linear ticket ID first).
- Releases use changesets (`bun run changeset`); `bun run release` builds and stages publishing. Add a changeset when changing a published package (`@brevi/cli`, `@brevi/orchestrator`, `@brevi/sandbox`, `@brevi/shared`, `@brevi/app`).
- CI (`.github/workflows/ci.yml`) runs lint, check-types, build, and the em-dash check on every PR.
