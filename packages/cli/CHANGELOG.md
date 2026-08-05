# @brevi/cli

## 0.3.0

### Minor Changes

- 3cc5cc7: Add `brevi update` (alias `brevi upgrade`): checks npm for the latest published release, detects how the CLI was installed (npm/bun/pnpm/yarn global install vs. npx/bunx/pnpm dlx), updates it in place, and links the changelog on brevi.dev before anything is installed. `brevi update --check` only reports (exit 1 when a newer version exists). `brevi ui`, `brevi start`, and `brevi status` now print a non-blocking notice when the running version is behind the latest on npm.
- 8f8fdaf: `npx @brevi/cli` is now the single entry point: running it with no arguments starts the orchestrator and opens the dashboard, and on first launch (no `~/.brevi/config.json`) it runs the init flow automatically first — a fresh machine goes from zero to dashboard in one command. In non-interactive terminals a missing config fails with a clear message instead of hanging on a prompt. The `ui` subcommand is deprecated and hidden (it now behaves like the bare invocation); `init`, `start`, and `status` are unchanged.
- 800c9dd: Mission Control quality-of-life redesign: every run now has its own URL (`/runs/<id>`) so run views can be shared by copying the address bar, all queued and finished runs live in the sidebar (the runs table is gone), and demo evidence stays with the local run's artifacts — nothing under `.brevi/` is committed to the branch or embedded in the pull request anymore. Tickets now opt in via the `brevi` label only; the `@brevi` title/description tag (`trigger.tag`) is gone. PR descriptions default to a new concise style, configurable via `github.prDescription` (`"concise"` | `"detailed"`). Successful runs move the Linear issue to the team's review state ("In Review") when one exists. Repos can map Linear projects explicitly (`repos.<key>.projects`, editable in the Connections panel).

## 0.2.0

### Minor Changes

- e6dc43c: The CLI now ships as a single self-contained package: the orchestrator, sandbox, and shared libraries are bundled into one file and the dashboard's built assets are included, so `npx @brevi/cli` installs one package with a single runtime dependency. The other @brevi packages are no longer published.

## 0.1.1

### Patch Changes

- Add package READMEs for npm, point the docs and README at the published CLI, and release through npm staged publishing.
- Updated dependencies
  - @brevi/orchestrator@0.1.1
  - @brevi/shared@0.1.1
