# brevi

A local sandbox and orchestrator for coding agents.

Connect your machine to Linear and GitHub, tag a ticket with **@brevi** (or the `brevi` label), and brevi picks it up:

- **SPIKE tickets** → runs a coding agent to research the question and posts the findings back to the Linear issue as a comment.
- **Implementation tickets** → runs a coding agent on a checkout of the mapped repo, pushes a branch, and opens a GitHub PR that includes a demo (screenshots or a screen recording) captured by the agent.

Every execution runs in an isolated sandbox. On Linux with KVM, sandboxes are [Firecracker](https://firecracker-microvm.github.io/) microVMs; elsewhere a local process sandbox is used for development.

## Quick start

```sh
# One-time setup: connect Linear + GitHub, map repos, pick a sandbox provider
npx @brevi/cli init

# Start the orchestrator and open the dashboard
npx @brevi/cli ui
```

Then assign yourself a Linear issue and put `@brevi` in its title/description (or add the `brevi` label). Add `SPIKE` for research-only tickets. Make sure `ANTHROPIC_API_KEY` is exported so the coding agent can run.

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

| Package | What it is |
| --- | --- |
| `@brevi/cli` | `brevi init` / `brevi ui` / `brevi start` / `brevi status` |
| `@brevi/orchestrator` | Linear polling, run pipeline, GitHub PRs, HTTP/WS API, serves the dashboard |
| `@brevi/sandbox` | Sandbox providers: Firecracker microVMs (Linux + KVM) and local process fallback |
| `@brevi/shared` | Domain types, config schema (zod), dashboard API/WebSocket protocol |
| `@brevi/app` | The dashboard — Vite + React, live run console, tickets, artifacts |
| `@brevi/docs` | Documentation site (Astro Starlight) |

## Development

Bun workspaces + Turborepo:

```sh
bun install
bun run build          # turbo run build (dependency-ordered)
bun run dev            # watch mode everywhere; dashboard dev server on :4401
bun run lint           # oxlint
bun run check-types
```

For Firecracker sandboxes you need a Linux host with `/dev/kvm`, a kernel image, and a rootfs — see `packages/sandbox/README.md` for the one-time image and network setup.
