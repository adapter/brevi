# @brevi/sandbox

The execution environment brevi runs coding agents in. One `Sandbox` holds one run's
workspace; the worker creates it, pushes a checkout in, execs the agent, pulls
artifacts out, and destroys it.

There is one provider: `bwrap` (Linux namespaces via [bubblewrap](https://github.com/containers/bubblewrap)).
A host that cannot run it (macOS, or Linux without `bwrap`) does not execute runs.

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

Every command runs under `bwrap` with a private `/tmp`, `/proc`, and `/dev`, a
read-only bind of host binaries (`/usr`, `/bin`, `/lib`, `/etc`), and a read-write
bind of the per-run directory (`~/.brevi/workspaces/<id>/`). The operator's `$HOME`
is not bound. The process `HOME` is `~/.brevi/workspaces/<id>/home`, beside the
checkout. Network is shared with the host so agents can use git, npm, and model APIs.

The Linux worker installer installs `bubblewrap` when it is missing. `createSandboxProvider()`
fails at startup if the host is not Linux or `bwrap` is missing or cannot unshare
user namespaces.

## Architecture

```
select.ts              always returns BwrapProvider
bwrap/provider.ts      create / rehydrate / discard
bwrap/wrap.ts          bwrap argv
exec.ts                shared streaming/capturing command runner
```
