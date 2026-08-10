# @brevi/shared

Shared domain definitions every other `@brevi` package builds on. No runtime behavior beyond config parsing.

## Layout (src/)

- `types.ts`: tickets, runs, run events, artifacts, credentials
- `config.ts`: the zod schema for `~/.brevi/config.json` (agent command/args/model, repos, sandbox provider, connect client ids, restart policy)
- `settings.ts`: the settings-patch layer over that schema (merge, defaults, secret and restart field lists), shared by the orchestrator's write path and the dashboard's forms
- `protocol.ts`: dashboard HTTP + WebSocket protocol types

## Gotchas

- These files are ground truth for the docs: changing `config.ts` or `protocol.ts` means updating `apps/docs/src/content/docs/reference/` (configuration.md, api.md).
- `config.ts` must stay free of node builtins: the dashboard imports `configSchema` to validate its forms with the exact rules the orchestrator applies, and runs in a browser.
- Every config field is editable at `/config`. Adding or changing one means adding or updating its form control in `apps/app/src/components/config/`, the same way it means updating configuration.md. A field with no control is a review-blocking omission.
- Config fields use zod defaults/`prefault` so older `~/.brevi/config.json` files keep parsing; prefer adding optional or defaulted fields over required ones.
