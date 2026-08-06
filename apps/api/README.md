# @brevi/api

brevi's hosted OAuth backend, a [Hono](https://hono.dev) app on Cloudflare Workers deployed to `api.brevi.dev`. It holds brevi's registered OAuth applications so local orchestrators get one-click Connect without every user creating their own apps. No user tokens are stored; responses go straight back to the requesting orchestrator, which persists them in the user's `~/.brevi/config.json`.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness (the orchestrator probes this before offering hosted flows) |
| `POST /oauth/github/device/code` | Start a GitHub device authorization with brevi's client id |
| `POST /oauth/github/device/token` | Poll it (`{device_code}` → token or GitHub's pending/error fields) |
| `GET /oauth/linear/authorize?state=&port=` | 302 to Linear's consent page; redirects back to `http://localhost:<port>/api/connect/linear/callback` |
| `POST /oauth/linear/token` | `{code, port}` → `{access_token}`; the client secret never leaves the worker |

## One-time setup

1. **GitHub OAuth app** (github.com/settings/developers): enable *Device flow*; no callback needed.
2. **Linear OAuth app** (linear.app/settings/api/applications): add callback `http://localhost:4400/api/connect/linear/callback` (plus any other ports you expect).
3. Secrets:

```sh
bunx wrangler secret put GITHUB_CLIENT_ID
bunx wrangler secret put LINEAR_CLIENT_ID
bunx wrangler secret put LINEAR_CLIENT_SECRET
```

4. Point the `api.brevi.dev` custom domain at the worker (configured in `wrangler.jsonc`) and deploy:

```sh
bun run deploy
```

Local development: `bun run dev` (wrangler dev on localhost), then set `connect.apiBase` in `~/.brevi/config.json` to the printed URL. Self-hosters can run their own copy and point `connect.apiBase` at it, or skip this service entirely by configuring `connect.githubClientId` / `connect.linearClientId` + `linearClientSecret` locally.
