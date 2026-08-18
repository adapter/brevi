# brevi

brevi turns Linear tickets into pull requests from Mission Control, a self-updating desktop app for macOS and Linux.

Download Mission Control from [brevi.dev/download](https://brevi.dev/download/). The app owns the orchestrator, stores state under `~/.brevi`, and renders its dashboard from a private local application origin. There is no web or CLI host.

Runs execute on Linux workers. Add one from **Configuration → Workers** by entering its SSH host, user, and optional private-key path. Mission Control verifies the SSH host key, installs the dedicated `brevi-worker` systemd service, enrolls it with a single-use token, and waits for it to connect.

## Development

```sh
bun install
bun run build
bun test
cd apps/desktop && bun run start
```

Workspaces:

- `apps/desktop`: Electron host and release package.
- `apps/app`: renderer loaded only by Electron through `brevi://app`.
- `packages/orchestrator`: scheduling and the private loopback API.
- `packages/worker`: dedicated Linux worker daemon and installer.
- `packages/sandbox`: bubblewrap execution.
- `packages/shared`: configuration and wire types.
- `apps/api`: hosted OAuth helper at `api.brevi.dev`.
- `apps/docs`: documentation at `brevi.dev`.

Mission Control releases are versioned by `apps/desktop/package.json`. Worker artifacts are versioned by `packages/worker/package.json` and published with the desktop release; nothing is published to npm.

## License

[MIT](LICENSE)
