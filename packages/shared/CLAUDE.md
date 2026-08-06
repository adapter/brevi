# @brevi/shared

Shared domain definitions every other `@brevi` package builds on. No runtime behavior beyond config parsing.

## Layout (src/)

- `types.ts`: tickets, runs, run events, artifacts, credentials
- `config.ts`: the zod schema for `~/.brevi/config.json` (agent command/args/model, repos, sandbox provider, connect client ids, restart policy)
- `protocol.ts`: dashboard HTTP + WebSocket protocol types

## Gotchas

- These files are ground truth for the docs: changing `config.ts` or `protocol.ts` means updating `apps/docs/src/content/docs/reference/` (configuration.md, api.md).
- Config fields use zod defaults/`prefault` so older `~/.brevi/config.json` files keep parsing; prefer adding optional or defaulted fields over required ones.
