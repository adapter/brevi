# @brevi/cli

## 0.2.0

### Minor Changes

- e6dc43c: The CLI now ships as a single self-contained package: the orchestrator, sandbox, and shared libraries are bundled into one file and the dashboard's built assets are included, so `npx @brevi/cli` installs one package with a single runtime dependency. The other @brevi packages are no longer published.

## 0.1.1

### Patch Changes

- Add package READMEs for npm, point the docs and README at the published CLI, and release through npm staged publishing.
- Updated dependencies
  - @brevi/orchestrator@0.1.1
  - @brevi/shared@0.1.1
