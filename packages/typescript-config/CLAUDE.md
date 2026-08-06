# @repo/typescript-config

Internal (unpublished) shared TypeScript configuration.

- `base.json`: the strict NodeNext baseline every workspace extends
- `react-library.json`: variant for React code

Browser and worker workspaces override `lib`/`types` locally (see `apps/app` and `apps/api` tsconfigs). Changes here affect every workspace's typecheck; run `bun run check-types` at the root after editing.
