# @brevi/app

The brevi dashboard: mission control for runs. Vite + React 19, Tailwind v4, and shadcn/ui on Base UI primitives, themed "cold room, warm signal": the chrome is cold ink, and the only warm color on screen is work happening right now.

The built `dist/` is published so [`@brevi/orchestrator`](https://www.npmjs.com/package/@brevi/orchestrator) can serve it; the dashboard is not run standalone by users.

## Development

```sh
bun run dev    # dev server on :4401, proxying /api and /ws to the orchestrator on :4400
bun run build
```

Start an orchestrator (`bun run brevi -- ui` from the repo root) for live data; without one the dashboard shows its offline state.

UI primitives live in `src/components/ui/` (shadcn-owned code), app components in `src/components/`, and the palette/theme bridge in `src/index.css`. Light/dark/system theming is CSS-variable based: the ink and haze ramps invert per theme, so components never branch on theme.

Docs: [brevi.dev](https://brevi.dev) · Source: [github.com/adapter/brevi](https://github.com/adapter/brevi)
