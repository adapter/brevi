---
title: Connections
description: How brevi's one-click Connect buttons acquire GitHub, Claude, Codex and Linear credentials, how they are validated, and where they are stored.
---

Every credential brevi uses is set from the dashboard's **Connections** rail. Each provider has one **Connect** button that walks a strategy chain: look for a credential that already exists on this machine, then an OAuth flow, and then, only if both fail, offer manual entry with a reason.

Nothing is saved until it has been checked against the provider. "Connected" means brevi made a live call with that credential and it worked.

## Where credentials live

All of them go into `~/.brevi/config.json`, under the field for their provider:

| Provider | Config field |
| --- | --- |
| Linear | `linear.apiKey` |
| GitHub | `github.token` |
| Claude (API key) | `agent.anthropicApiKey` |
| Claude (Claude Code login) | `agent.claudeCodeOauthToken` |
| Codex (API key) | `agent.codexApiKey` |
| Codex (ChatGPT login) | `agent.codexAuthJson` |

The orchestrator never reads environment variables to configure itself. Variables like `ANTHROPIC_API_KEY` are only *discovered* by a Connect button and then written to the config; changing the variable later has no effect on saved runs.

Whenever the config is sent to the dashboard (`GET /api/config`, the WebSocket `hello`/`config` messages, every Connect response), secrets are replaced with `***`. An empty string is left as-is so the UI can tell "not connected" apart from "connected". `connect.linearClientSecret` is redacted the same way.

:::caution
`~/.brevi/config.json` is a plaintext file containing live tokens. Treat it like `~/.ssh`: it is not encrypted and brevi does not manage its permissions for you.
:::

## GitHub

Used to clone repositories, push branches, open pull requests, and list the repos in the dashboard's picker.

1. **`gh` CLI**: brevi runs `gh auth token`. If it returns a token, the token is validated with `GET https://api.github.com/user` and saved. The detail reads `Connected as <login> (via gh CLI)`.
2. **OAuth device flow**: otherwise brevi starts a device authorization with scopes `repo` and `workflow` and returns a user code plus a verification URL. The dashboard shows the code, opens GitHub, and polls `POST /api/connect/github/poll` until GitHub issues a token (or the code expires).
3. **Manual**: paste a personal access token with the `repo` and `workflow` scopes.

## Claude

The default coding agent. brevi looks for a credential in this order:

1. `ANTHROPIC_API_KEY` in the orchestrator's environment.
2. `CLAUDE_CODE_OAUTH_TOKEN` in the orchestrator's environment.
3. Your **Claude Code login**: on macOS, the Keychain item `Claude Code-credentials`; on every platform, `~/.claude/.credentials.json`. brevi reads `claudeAiOauth.accessToken`.

Whatever is found is verified with a real one-token request to `claude-haiku-4-5`. API keys authenticate with `x-api-key`; Claude Code OAuth tokens with `Authorization: Bearer` plus the OAuth beta header. A successful probe reads `Verified with claude-haiku-4-5`, followed by the credential's source, e.g. `Claude Code login (Keychain)`.

API keys are saved to `agent.anthropicApiKey`, OAuth tokens to `agent.claudeCodeOauthToken`. Entering a key manually replaces any host-discovered login (the OAuth token is cleared) so there is exactly one active Claude credential.

## Codex

An alternative agent, including ChatGPT-plan logins that have no API key at all:

1. `OPENAI_API_KEY` in the orchestrator's environment.
2. `~/.codex/auth.json` with an `OPENAI_API_KEY` field, which is the Codex CLI's API-key login.
3. `~/.codex/auth.json` with an OAuth token set (`tokens.access_token`), which is a **ChatGPT login**. The whole file is captured, not just a token, and stored in `agent.codexAuthJson`.

API keys are verified with a one-token completion on `gpt-5-nano`; if that model isn't available on the account, brevi falls back to an authentication-only check against `/v1/models`.

A ChatGPT login can't be probed the same way, so it is validated offline: the token set must parse and contain an access token, and if the access token has expired there must be a refresh token. brevi decodes the `id_token` to report who you are: `Connected as you@example.com (ChatGPT pro)`.

At run time a ChatGPT login travels as a *file*, not an environment variable. brevi writes it to `.brevi/codex-home/auth.json` inside the sandbox workspace and points `CODEX_HOME` at that directory, which is what the Codex CLI reads. The directory is deleted again before anything is committed, so the login can never reach a branch.

Connecting Codex only stores the credential; which CLI actually runs is `agent.command`, which defaults to `claude`. See the [configuration reference](/reference/configuration/).

## Linear

The ticket source.

1. **OAuth redirect**: brevi builds a `https://linear.app/oauth/authorize` URL with scope `read,write`, `actor=user`, a random `state`, and a redirect back to `http://localhost:<port>/api/connect/linear/callback`. You approve in the browser; the callback exchanges the code for a token server-side, validates it, saves it, and broadcasts the new config to the dashboard. The authorization expires after 10 minutes.
2. **Manual**: paste a personal API key from Linear's settings.

Both are validated with a `{ viewer { name email } }` GraphQL query. Keys beginning with `lin_api_` are sent as a raw `Authorization` header; OAuth access tokens are sent as `Bearer`.

Connecting or disconnecting Linear takes effect immediately: brevi rebuilds its Linear client and polls again without a restart.

## Cloudflare R2

Publishes a successful run's demo evidence, screenshots and recordings, to a public bucket so it can be embedded inline in the PR description. Unlike every other provider on this page, brevi stores no credential for it: authentication lives entirely with the host's `wrangler` CLI, the same one you'd use for any other Cloudflare work.

The Connect button:

1. Probes `wrangler whoami`. If it already reports an authenticated identity, the card shows connected immediately.
2. Otherwise, if wrangler is installed, it starts `wrangler login` on the host, which opens a browser for interactive OAuth. The dashboard polls the live status until `wrangler whoami` succeeds.
3. If wrangler isn't installed at all, there's no automatic path; the card tells you to install it.

The card surfaces three distinct not-ready states, so you always know what's missing: wrangler not installed, wrangler installed but not logged in, and logged in but the bucket or public base URL not yet configured.

Setup:

1. Install the `wrangler` CLI on the host running the orchestrator.
2. Create an R2 bucket in your Cloudflare account (brevi does not create it for you).
3. Enable the bucket's r2.dev public development URL, or attach a custom domain to it.
4. Click Connect to authenticate, then set the bucket name and its public base URL in the panel. Both are saved via `PUT /api/settings/r2`.

Runs triggered while R2 isn't fully configured, logged out, or wrangler is missing behave exactly as before: evidence stays local and a note appears in the run's console instead of a failure.

To disconnect, run `wrangler logout` on the host; the next probe reports logged out.

## The role of api.brevi.dev

The GitHub device flow needs a client id, and the Linear code exchange needs a client secret that must not sit on your laptop. brevi hosts those OAuth applications at **`https://api.brevi.dev`**, a small Cloudflare Worker (see `apps/api`). The local orchestrator uses it automatically when you haven't configured your own OAuth app, so one-click Connect works out of the box with nothing to register.

What crosses the wire is only what the OAuth flow requires: a device-code request, a device-token poll, an authorize redirect, and a code exchange. Issued tokens are stored locally in `~/.brevi/config.json`; api.brevi.dev doesn't keep them, and it never sees your repositories, tickets, or agent keys.

Self-hosters have two escape hatches, both under `connect` in the config:

```json
{
  "connect": {
    "apiBase": "https://api.brevi.dev",
    "githubClientId": "",
    "linearClientId": "",
    "linearClientSecret": ""
  }
}
```

- Set `connect.apiBase` to point the flows at your own deployment of `apps/api`.
- Or register your own OAuth apps and set `connect.githubClientId` / `connect.linearClientId` + `connect.linearClientSecret`. When a personal app is configured, brevi talks to GitHub and Linear directly and api.brevi.dev is not involved.

A Linear OAuth app used this way must register redirect URIs of the form `http://localhost:<port>/api/connect/linear/callback` for the port brevi runs on (4400 by default).

## Manual entry and disconnecting

Manual entry is always available as a fallback, on every provider. It goes through `PUT /api/settings/credentials`, which validates each field it is given: invalid keys are rejected per field, and valid keys in the same request are still applied and persisted.

Sending an empty string for a field disconnects that provider without validation. Disconnecting Claude or Codex also clears the matching host-discovered login.

## How credentials reach a run

When a run starts, brevi builds the sandbox environment purely from the config:

| Config field | Inside the sandbox |
| --- | --- |
| `agent.anthropicApiKey` | `ANTHROPIC_API_KEY` |
| `agent.claudeCodeOauthToken` | `CLAUDE_CODE_OAUTH_TOKEN` |
| `agent.codexApiKey` | `OPENAI_API_KEY` |
| `agent.codexAuthJson` | `$CODEX_HOME/auth.json` |

If none of them is set, the run fails immediately with `no agent credentials configured`.

The GitHub token is deliberately **not** in that list. Cloning and pushing happen outside the sandbox, and brevi rewrites the checkout's `origin` to a plain URL before pushing the code in, so the token never ships into the guest via `.git/config`.
