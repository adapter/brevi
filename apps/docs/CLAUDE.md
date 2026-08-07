# @brevi/docs

The documentation site at brevi.dev, built with Astro + Starlight, deployed to Cloudflare Workers by CI.

## Layout

- `src/content/docs/`: all pages (landing `index.mdx`, `getting-started.mdx`, `guides/`, `reference/`)
- `astro.config.mjs`: sidebar and site metadata

## Development

- `bun run dev`: dev server at localhost:4321. `bun run build` then `bun run preview` to check the static build.

## Gotchas

- The reference pages mirror source code, which is ground truth: `packages/shared/src/config.ts` (configuration.md), `packages/shared/src/protocol.ts` (api.md), `packages/cli/src/commands/` (cli.md). Update the docs whenever those change, and verify against the source rather than other docs.
- The worker (`src/worker.ts`) reverse-proxies PostHog under `/ingest/*`; the client in `src/components/Head.astro` points at it via `window.location.origin`.
