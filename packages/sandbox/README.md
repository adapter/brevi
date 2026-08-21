# @brevi/sandbox

The execution environment brevi runs coding agents in. One `Sandbox` holds one run's
workspace; the worker creates it, pushes a checkout in, execs the agent, pulls
artifacts out, and destroys it.

There is one concrete `Sandbox` implementation, parameterized by a per-platform
strategy: `bwrap` on Linux (namespace isolation via
[bubblewrap](https://github.com/containers/bubblewrap) plus [pasta](https://passt.top))
and `seatbelt` on macOS (`sandbox-exec` policy confinement; the weaker of the two).
A host that cannot run its platform's sandbox does not execute runs.

## Interface

```ts
const provider = await createSandboxProvider();
const sandbox = await provider.create({ id: runId, env: { ANTHROPIC_API_KEY } });

await sandbox.pushDirectory(localCheckout, ".");
const result = await sandbox.exec("claude", ["-p", prompt], { onStdout: log });
await sandbox.pullDirectory("artifacts", localArtifacts);
await sandbox.destroy();
```

`exec` never throws on a non-zero exit; inspect `result.exitCode`. Output is streamed to
`onStdout`/`onStderr` as it arrives and the last ~2 MB of each stream is also returned in
the result. Timeouts kill the command and report exit code `124`. Relative `cwd` and
relative paths given to `pushDirectory`/`writeFile`/… resolve against `workspacePath`.

## Isolation

On Linux, every command runs under `bwrap` inside a pasta network namespace, with a
private `/tmp`, `/proc`, and `/dev`, a read-only bind of host binaries (`/usr`, `/bin`,
`/lib`, `/etc`), and a read-write bind of the per-run directory
(`~/.brevi/workspaces/<id>/`). The operator's `$HOME` is not bound. The process `HOME`
is `~/.brevi/workspaces/<id>/home`, beside the checkout. Networking is outbound-only
and user-mode: pasta denies host-loopback splicing, host port publishing, and the
gateway mapping, so the sandbox can reach git, npm, and model APIs but never the
host's 127.0.0.1 services; DNS is forwarded through pasta's resolver address.

On macOS, every command runs under `sandbox-exec` with a per-run SBPL profile:
writes are limited to the run root and tmp, the operator's credential trees and the
rest of `~/.brevi` are unreadable, and outbound network is open. There is no PID
namespace, so each exec leads its own process group and release/destroy reap the
groups.

The Linux worker installer installs `bubblewrap` and `passt` when they are missing.
`createSandboxProvider()` fails at startup if the host cannot pass its platform's
sandbox probe (e.g. `bwrap` missing or user namespaces disabled on Linux).

## Architecture

```
select.ts              picks the platform strategy (Linux: bwrap, macOS: seatbelt)
provider.ts            the one Sandbox/SandboxProvider, parameterized by a strategy
bwrap/strategy.ts      bwrap availability probe and per-run setup
bwrap/wrap.ts          bwrap + pasta argv
seatbelt/strategy.ts   Seatbelt availability probe and per-run profile
seatbelt/policy.ts     SBPL profile text
seatbelt/wrap.ts       sandbox-exec argv
hostfs.ts              symlink-safe host-side file ops into agent-controlled trees
exec.ts                shared streaming/capturing command runner
```
