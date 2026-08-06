# @brevi/api

brevi's hosted OAuth backend at api.brevi.dev: a Hono app on Cloudflare Workers (single `src/index.ts`, config in `wrangler.jsonc`). It holds brevi's registered OAuth apps (GitHub device flow, Linear browser OAuth) so local orchestrators get one-click Connect. Stateless: no user tokens are stored; responses go straight back to the requesting orchestrator.

## Endpoints

`GET /health`, `POST /oauth/github/device/code`, `POST /oauth/github/device/token`, `GET /oauth/linear/authorize`, `POST /oauth/linear/token`. See README.md for details.

## Development and deploys

- `bun run dev`: wrangler dev on localhost; point `connect.apiBase` in `~/.brevi/config.json` at it to test the Connect flows.
- Secrets (`GITHUB_CLIENT_ID`, `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`) live in Worker secrets via `bunx wrangler secret put`; never commit them.
- Deployed by CI on main; manual `bun run deploy` / `bun run deploy:preview` also exist.
- The Linear client secret must never leave the worker; keep token exchanges server-side.
