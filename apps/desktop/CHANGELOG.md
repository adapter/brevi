# @brevi/desktop

## 0.2.1

### Patch Changes

- ed5ef1d: Bump minor and patch dependencies, including wrangler to 4.123.0.
- 11f710a: Fix the macOS universal build by covering @lydell/node-pty platform binaries with x64ArchFiles. Bun installs both darwin platform packages, so the x64 and arm64 legs carried identical prebuilds and @electron/universal refused to merge them.
- df62211: R2 publish steps now invoke wrangler via bunx instead of npx, fixing the exit-127 "wrangler: not found" failures that left worker binaries unpublished (npm tripped over the repo's bun packageManager and never put the wrangler bin on PATH). Versioning now runs through a changesets "Release: version packages" PR instead of hand-edited package.json versions.
