# @brevi/app

The brevi dashboard: mission control for runs. Vite + React 19, Tailwind v4, shadcn/ui on Base UI primitives. Not run standalone by users: the built `dist/` is copied into `@brevi/cli`'s bundle and served by the orchestrator.

## Development

- `bun run dev`: dev server on :4401, proxying `/api` and `/ws` to an orchestrator on :4400. Start one with `bun run brevi -- ui` from the repo root; without it the dashboard shows its offline state.
- Protocol types come from `@brevi/shared` (`protocol.ts`); do not redefine them here.

## Layout (src/)

- `components/ui/`: shadcn-owned primitives. Treat as vendored: regenerate or extend via wrappers rather than hand-editing.
- `components/`: app components
- `hooks/`, `lib/`: data fetching and helpers
- `index.css`: palette and theme bridge

## Theming

Design language is "cold room, warm signal": chrome is cold ink, the only warm color is work happening right now. Light/dark/system theming is CSS-variable based; the ink and haze ramps invert per theme, so components must never branch on theme. Use the CSS variables, not raw colors.
