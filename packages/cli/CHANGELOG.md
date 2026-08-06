# @brevi/cli

## 0.4.0

### Minor Changes

- 33aba10: Runs interrupted by a Claude or Codex usage limit now park as waiting and restart on their own once the limit lifts, with Retry buttons in the dashboard.
- 7ebe58e: Implementation runs now drive the Claude orchestrator at high reasoning effort and add an adversarial Codex review with a fix pass before the PR opens.
- ad68279: Runs start faster and cheaper: an orchestrator model delegates coding to a subagent, prompts carry a repo map, and Chromium is provisioned once per host.
- f5f6997: Runs can now upload demo evidence to a public Cloudflare R2 bucket via wrangler and embed screenshots and clickable GIF video previews in PR descriptions.
- 7a2b1ae: Connecting Cloudflare R2 is now one click: after the wrangler login, brevi creates the evidence bucket and enables its public r2.dev URL automatically.
- a25759c: Removed the SPIKE ticket kind: every brevi-labeled ticket now runs the full implementation pipeline to a pull request; trigger.spikeMarker is gone.
- d832345: Finished runs keep their sandbox disk for 24 hours; an embedded web terminal on the run page and brevi attach resume the agent conversation in it.
- 645a0ed: Runs now record total LLM cost and token usage across providers and attempts, with a per-execution breakdown shown on run cards and the run detail view.
- 8d35dc9: New `sandbox.concurrency` setting caps how many sandboxed runs execute at once, adjustable live from Mission Control's Sandbox page without a restart.
- 31f45eb: `brevi update` now restarts a running instance after installing: the old process is stopped and the new version relaunched, no manual restart needed.

### Patch Changes

- 6668fa6: Mission Control drops the run-count stats and the npx command hint from the header and sidebar chrome, keeping the badges and the theme toggle.
- a350c3c: The Configuration page is now split into Connectors, Repositories, and Sandbox subpages, each with its own URL and reachable from a submenu.
- 1a6eeb1: Mission Control replaces the permanent Connections sidebar with a Configuration page at /config, opened from a gear button that flags disconnected providers.
- 9d561c4: The run console no longer leaks status or token-progress noise, shows one deduped thinking line per spell, and counts up live while the agent thinks.
- d406d7c: The GitHub connect flow now requests the workflow scope, so runs can push branches that touch (or lag behind) files under .github/workflows.
- b154e1c: Mission Control: queued runs show no timer, run detail splits into console and a sticky output card, costs become badges, theme toggle moves to the sidebar.
- 31713ed: Tickets now reliably end up In Review after a successful run: brevi re-asserts the state when Linear's GitHub automation reverts it, and logs every move.
- 3d44a45: The run detail header now shows the repo and ticket state badges beside the Cancel/Retry controls, replacing the started-ago text and the title row badges.
- 3dd2f40: The runs sidebar now shows two sections: active runs on top with queued runs in scheduler pickup order below, and finished runs separated underneath.
- 83b4b32: Fixes the console noise filter to match how Claude Code really emits status and thinking_tokens (system-event subtypes), so they stay out of the log.

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
