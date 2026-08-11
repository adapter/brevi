import type { ArtifactRef, CostEntry, Run, RunAttempt, RunEvent, RunStatus } from "@brevi/shared";

/**
 * The subset of the host's run store one run mutates. `runner.ts` and
 * `followup.ts` were written against the orchestrator's `RunStore` and moved
 * here largely unchanged; this interface is the seam that lets them keep
 * doing that without actually depending on a store. On the host, `RunStore`
 * satisfies it directly (its methods are a superset). On a worker there is
 * no run store at all: `RunReporter` (reporter.ts) implements it by mirroring
 * every mutation to the host over the wire protocol, so from the runner's
 * point of view a dispatched run behaves exactly like one running against a
 * local store.
 *
 * A patch stays domain-shaped (`sandbox.retainedUntil` is `string |
 * undefined`, never `null`): the `null`-means-clear convention is a wire-only
 * concern, translated by RunReporter when it builds the wire patch (see
 * reporter.ts's toRunPatch). A caller here clears retention the same way it
 * clears any other optional field: name the key with an explicit `undefined`.
 */
export interface RunSink {
  get(runId: string): Run | undefined;
  update(runId: string, patch: Partial<Omit<Run, "id">>): Promise<Run>;
  setStatus(runId: string, status: RunStatus, patch?: Partial<Omit<Run, "id">>): Promise<Run>;
  appendEvent(event: RunEvent): void;
  beginAttempt(runId: string, kind?: RunAttempt["kind"]): Promise<RunAttempt>;
  endAttempt(runId: string, patch: Partial<Omit<RunAttempt, "number" | "startedAt">>): Promise<void>;
  addCost(runId: string, entry: CostEntry, executionId?: string): Promise<void>;
  upsertCost(runId: string, executionId: string, entry: CostEntry): Promise<void>;
  addArtifact(runId: string, artifact: ArtifactRef): Promise<void>;
  artifactsDir(runId: string): string;
}
