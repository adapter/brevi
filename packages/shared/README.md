# @brevi/shared

Shared domain types for [brevi](https://brevi.dev): tickets, runs, run events, artifacts, credentials, the zod config schema for `~/.brevi/config.json`, and the dashboard HTTP/WebSocket protocol types.

Every other `@brevi` package builds on these definitions; this package has no runtime behavior beyond config parsing.

```ts
import { type Run, type Ticket, BreviConfigSchema } from "@brevi/shared";
```

Docs: [brevi.dev](https://brevi.dev) · Source: [github.com/adapter/brevi](https://github.com/adapter/brevi)
