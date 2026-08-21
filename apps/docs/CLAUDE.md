# @brevi/docs

The documentation site at brevi.dev, built with Astro + Starlight, deployed to Cloudflare Workers by CI. Production deploys are release-coupled: docs-deploy.yml fires after the Desktop release workflow publishes successfully (with workflow_dispatch as the escape hatch for out-of-band fixes), not on every push to main. PR preview deploys stay in ci.yml.

## Layout

- `src/content/docs/`: all pages (landing `index.mdx`, `getting-started.mdx`, `guides/`, `reference/`)
- `astro.config.mjs`: sidebar and site metadata

## Development

- `bun run dev`: dev server at localhost:4321. `bun run build` then `bun run preview` to check the static build.

## Gotchas

- Reference pages mirror source code: `packages/shared/src/config.ts` (configuration), `packages/shared/src/protocol.ts` (API), and `packages/worker` (workers). Update docs when those change.
- The worker (`src/worker.ts`) reverse-proxies PostHog under `/ingest/*`; the client in `src/components/Head.astro` points at it via `window.location.origin`.
- The PostHog project token is not in source: it is injected at build time via the `PUBLIC_POSTHOG_TOKEN` env var (a GitHub repository variable used by ci.yml and docs-deploy.yml), and analytics are disabled when it is unset.
