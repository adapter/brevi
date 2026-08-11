# @brevi/sandbox

The execution environment for agent runs. One `Sandbox` holds one run's workspace: the orchestrator creates it, pushes a checkout in, execs the agent, pulls artifacts out, destroys it.

## Layout (src/)

- `types.ts`: the `Sandbox` / `SandboxProvider` interface both providers implement
- `select.ts`: provider selection (`auto` picks Firecracker only when the full preflight passes: everything `ensureAvailable()` checks plus networking (tap devices, IPv4 forwarding) and a resolvable, current-version rootfs (from-source or downloaded); otherwise process; `auto` never fails, it downgrades)
- `firecracker/`: microVM provider (separate kernel and rootfs; Linux + KVM only)
  - `rootfs.ts`: versioned prebuilt rootfs resolution: download from `sandbox.firecracker.rootfsBaseUrl`, sha256 verify, cache under `~/.brevi/cache/rootfs/<cli version>/`, prune entries unused for 30 days
- `process/`: plain-directory provider (no isolation; used on macOS and for development)
- `exec.ts`, `host.ts`, `paths.ts`: shared exec/streaming and path helpers

## Gotchas

- `exec` never throws on non-zero exit; inspect `result.exitCode`. Timeouts kill the command and report exit code 124. Only the last ~2 MB of each stream is kept in the result (full streams go to `onStdout`/`onStderr`).
- Relative paths (`cwd`, `pushDirectory`, `writeFile`, ...) resolve against `workspacePath`.
- Explicit `"firecracker"`/`"process"` config is validated at startup via `ensureAvailable()` so misconfiguration fails early with one aggregated error.
- Firecracker needs one-time image and network setup; see README.md in this package.
