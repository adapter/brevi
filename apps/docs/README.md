# @brevi/docs

The brevi documentation site, built with [Astro](https://astro.build) + [Starlight](https://starlight.astro.build).

Pages live in `src/content/docs/`; the sidebar and site metadata are in `astro.config.mjs`.

```
src/content/docs/
├── index.mdx                 landing page
├── getting-started.mdx       install, first run, first ticket
├── guides/
│   ├── connections.md        Connect flows, credential storage, api.brevi.dev
│   ├── tickets.md            eligibility, repo routing, run output, reruns
│   └── sandboxes.md          provider selection, Firecracker setup, caveats
└── reference/
    ├── cli.md                brevi init / ui / start / status
    ├── configuration.md      ~/.brevi/config.json schema
    └── api.md                orchestrator HTTP + WS protocol, api.brevi.dev
```

## Commands

| Command | Action |
| --- | --- |
| `bun run dev` | Dev server at `localhost:4321` |
| `bun run build` | Build the static site to `./dist/` |
| `bun run preview` | Preview the build locally |
| `bun run lint` | oxlint |

Ground truth for the reference pages is the source: `packages/shared/src/config.ts` (configuration), `packages/shared/src/protocol.ts` (API), `packages/cli/src/commands/` (CLI). Update these docs when those change.
