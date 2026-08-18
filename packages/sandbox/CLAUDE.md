# @brevi/sandbox

The execution environment for agent runs. One `Sandbox` holds one run's workspace: the worker creates it, pushes a checkout in, execs the agent, pulls artifacts out, destroys it.

## Layout (src/)

- `types.ts`: the `Sandbox` / `SandboxProvider` interface
- `select.ts`: `createSandboxProvider()` picks by platform (Linux: bwrap, macOS: seatbelt) after `ensureAvailable()`
- `bwrap/`: bubblewrap provider (Linux namespaces); every launch runs through pasta (passt) for a private netns with outbound-only user-mode networking, no host loopback access
- `seatbelt/`: macOS provider: per-run SBPL profile run through `sandbox-exec`. Policy confinement, not namespaces: writes limited to the run root and tmp, credential trees and the rest of `~/.brevi` unreadable, outbound network open. The weaker of the two providers
- `exec.ts`, `host.ts`, `paths.ts`: shared exec/streaming and path helpers
- `hostfs.ts`: symlink-safe host-side reads/writes into agent-controlled trees (Linux: dirfd walk with O_NOFOLLOW; macOS: O_NOFOLLOW_ANY)

## Gotchas

- `exec` never throws on non-zero exit; inspect `result.exitCode`. Timeouts kill the command and report exit code 124. Only the last ~2 MB of each stream is kept in the result (full streams go to `onStdout`/`onStderr`).
- Relative paths (`cwd`, `pushDirectory`, `writeFile`, ...) resolve against `workspacePath`.
- There is no process fallback. A host that cannot run its platform's sandbox must not execute runs.
- Seatbelt has no PID namespace, so the provider runs each exec as its own process group and SIGKILLs every group on release/destroy to reap daemonized descendants. A grandchild that calls setsid escapes its group and is not reaped; this is a residual gap versus bwrap, and pid reuse between an exec finishing and teardown is a small theoretical risk on that path.
