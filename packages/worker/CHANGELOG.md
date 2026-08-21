# @brevi/worker

## 0.2.1

### Patch Changes

- df62211: R2 publish steps now invoke wrangler via bunx instead of npx, fixing the exit-127 "wrangler: not found" failures that left worker binaries unpublished (npm tripped over the repo's bun packageManager and never put the wrangler bin on PATH). Versioning now runs through a changesets "Release: version packages" PR instead of hand-edited package.json versions.
- @brevi/integrations@0.2.1
  - @brevi/sandbox@0.2.1
  - @brevi/shared@0.2.1
