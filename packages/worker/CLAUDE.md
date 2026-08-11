# @brevi/worker

The `brevi worker` daemon. Holds today's execution stack behind the dispatch protocol in `@brevi/shared`'s `worker.ts`: dials a `brevi` host over one outbound WebSocket, executes whatever it dispatches, and mirrors every run mutation back over that socket. The host is a pure scheduler and never touches a sandbox itself; every run's sandbox lives on the worker that executed it. A worker only ever dials out, it never listens, and its `sandbox.*` config (provider, Firecracker image paths, VM size) is read from its own local `~/.brevi/config.json`, never trusted from the host: a worker's provider and images are local to its machine.

## Layout (src/)

- `daemon.ts`: `runWorker()`, the entry point. Loads local config, resolves the sandbox provider, connects, and routes every host message (dispatch, cancel, discard, attach-*) to the right handler until SIGINT/SIGTERM
- `connection.ts`: the outbound WebSocket client: register, heartbeat, exponential backoff with jitter on a drop, and a bounded outbound queue that flushes in order after the next successful registration
- `reporter.ts`: `RunReporter`, a `RunSink` that mirrors every run mutation to the host as `run-patch`/`run-event`/`run-artifact` messages instead of writing to a local store
- `sink.ts`: `RunSink`, the seam `runner.ts`/`followup.ts` were written against instead of the host's `RunStore` directly (see the doc comment there for why)
- `attach.ts`: worker-side interactive sessions (`brevi attach`, the dashboard's web terminal): rehydrates a finished run's retained sandbox, reprovisions credentials, and bridges its PTY to the host over attach-* messages
- `identity.ts`: a stable per-machine worker id (`~/.brevi/worker-id`), so a reconnect is recognised as the same worker
- `runner.ts` / `followup.ts`: one run end to end (moved from `@brevi/orchestrator`, largely unchanged; see internal.ts in that package for what they still borrow from the host side)
- `prompts.ts`, `limits.ts`-adjacent bits, `costs.ts`, `ccusage.ts`, `provision.ts`, `resume.ts`, `review.ts`: the rest of the execution stack, also moved from `@brevi/orchestrator`

## Gotchas

- The dependency with `@brevi/orchestrator` runs one way: this package imports node-side helpers (GitHub, Linear, R2, usage-limit and memory helpers) from `@brevi/orchestrator/internal`, but the orchestrator never imports `@brevi/worker` or `@brevi/sandbox`. `grep -rn "@brevi/sandbox" packages/orchestrator` must stay empty, which CI enforces.
- `runner.ts`/`followup.ts` know nothing about sockets or leases: they only see a `RunSink`, the dispatch's prompt policy, and a couple of memory-recall callbacks on `RunContext`. All the wire-protocol plumbing lives in `reporter.ts` and `daemon.ts`, so the run pipeline itself reads the same whether it once ran on the host or now runs here.
- A patch handed to `RunSink` stays domain-shaped: naming a field with an explicit `undefined` clears it, and `RunReporter` is what translates that into the wire's `null` (`sandbox` included, one level deeper). Nothing outside `reporter.ts` should know the `null` convention exists.
- Holding a lease and executing a run are two different things (`claimedLeases` and `activeRuns` in `daemon.ts`). A lease is claimed from dispatch until the host's `run-complete-ack`, so a run that finishes while the socket is down is still listed on the next `register` and its buffered completion replays instead of the host stranding it. Removing a lease on anything other than that acknowledgement reintroduces the bug.
- Shutdown order is load-bearing (see the comment in `daemon.ts`): stop accepting dispatches, abort the active runs, await their executions, drain the outbound queue, and only then close the socket. Closing earlier drops a run's final `run-complete` forever; skipping the abort or the await leaves microVMs running with nothing left to report their exit.
- A worker forgets everything about runs it executed before its last restart: `knownRuns` in `daemon.ts` starts empty on boot, so leftover workspace directories are swept unconditionally and `brevi attach` to a sandbox retained before a restart won't find it. A later fleet iteration can persist enough state to survive a restart; this one keeps it simple.
- Artifacts only exist on the worker's disk (the host's `RunStore` has no filesystem access to it), so `RunReporter.addArtifact` reads the file and ships its bytes as base64 in a `run-artifact` message, skipping (with a logged system event) anything over `WORKER_MAX_ARTIFACT_BYTES`.
