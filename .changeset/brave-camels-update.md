---
"@brevi/cli": minor
---

Add `brevi update` (alias `brevi upgrade`): checks npm for the latest published release, detects how the CLI was installed (npm/bun/pnpm/yarn global install vs. npx/bunx/pnpm dlx), updates it in place, and links the changelog on brevi.dev before anything is installed. `brevi update --check` only reports (exit 1 when a newer version exists). `brevi ui`, `brevi start`, and `brevi status` now print a non-blocking notice when the running version is behind the latest on npm.
