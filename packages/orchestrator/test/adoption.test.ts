import { describe, expect, it } from "bun:test";
import type { Run } from "@brevi/shared";
import { adoptableFromAttempt, attemptStartOf, planRunRecovery } from "../src/scheduler.js";
import type { RestoredLease } from "../src/workers.js";

// Run with `bun test packages/orchestrator` from the repo root (after
// `bun run build`, so the @brevi/shared import resolves to its dist output).
//
// The two decisions the scheduler makes about a run nobody is executing any
// more: whether to adopt a pull request instead of rerunning it, and what to
// do with it after a host restart. Both are cheap to get wrong in expensive
// ways (a ticket marked done that nobody finished; the same run handed to two
// workers), so both are pinned down here as pure rules.

const ATTEMPT_STARTED = "2026-08-11T10:00:00.000Z";
/** Opened during the attempt: what a worker that got to the end leaves behind. */
const DURING = "2026-08-11T10:20:00.000Z";
/** Opened before the attempt: a previous attempt's, or a previous run's. */
const BEFORE = "2026-08-11T09:00:00.000Z";

describe("adoptableFromAttempt", () => {
  it("adopts a pull request this implementation attempt opened", () => {
    expect(
      adoptableFromAttempt({
        kind: "implementation",
        attemptStartedAt: ATTEMPT_STARTED,
        pr: { state: "open", createdAt: DURING },
      }),
    ).toBe(true);
  });

  it("never adopts for a follow-up, even when the pull request is open and freshly touched", () => {
    // The whole reason a follow-up runs is that this pull request exists, so
    // finding it proves nothing about whether the interrupted attempt rebased
    // or addressed a single review comment.
    expect(
      adoptableFromAttempt({
        kind: "follow-up",
        attemptStartedAt: ATTEMPT_STARTED,
        pr: { state: "open", createdAt: BEFORE },
      }),
    ).toBe(false);
    // Not even one created inside the attempt's window: a follow-up is
    // requeued, full stop.
    expect(
      adoptableFromAttempt({
        kind: "follow-up",
        attemptStartedAt: ATTEMPT_STARTED,
        pr: { state: "open", createdAt: DURING },
      }),
    ).toBe(false);
  });

  it("refuses a pull request that already existed when the attempt began", () => {
    // A retry carries the previous attempt's prUrl (Run.prUrl survives a
    // requeue on purpose) and lands on the same branch, so the PR is there
    // whether or not this attempt did anything.
    expect(
      adoptableFromAttempt({
        kind: "implementation",
        attemptStartedAt: ATTEMPT_STARTED,
        pr: { state: "open", createdAt: BEFORE },
      }),
    ).toBe(false);
  });

  it("refuses a closed pull request, whenever it was opened", () => {
    expect(
      adoptableFromAttempt({
        kind: "implementation",
        attemptStartedAt: ATTEMPT_STARTED,
        pr: { state: "closed", createdAt: DURING },
      }),
    ).toBe(false);
  });

  it("adopts a merged pull request the attempt opened", () => {
    expect(
      adoptableFromAttempt({
        kind: "implementation",
        attemptStartedAt: ATTEMPT_STARTED,
        pr: { state: "merged", createdAt: DURING },
      }),
    ).toBe(true);
  });

  it("refuses rather than guesses when either timestamp is unusable", () => {
    expect(
      adoptableFromAttempt({
        kind: "implementation",
        attemptStartedAt: "not a date",
        pr: { state: "open", createdAt: DURING },
      }),
    ).toBe(false);
    expect(
      adoptableFromAttempt({
        kind: "implementation",
        attemptStartedAt: ATTEMPT_STARTED,
        pr: { state: "open", createdAt: "" },
      }),
    ).toBe(false);
  });
});

describe("attemptStartOf", () => {
  const base: Pick<Run, "attempts" | "startedAt" | "createdAt"> = {
    attempts: [],
    createdAt: "2026-08-11T08:00:00.000Z",
  };

  it("uses the latest attempt's start, so a retry is measured from its own attempt", () => {
    const run = {
      ...base,
      startedAt: "2026-08-11T08:30:00.000Z",
      attempts: [
        { number: 1, startedAt: "2026-08-11T08:30:00.000Z", finishedAt: "2026-08-11T09:00:00.000Z", outcome: "failed" as const },
        { number: 2, startedAt: ATTEMPT_STARTED },
      ],
    };
    expect(attemptStartOf(run)).toBe(ATTEMPT_STARTED);
    // The PR the first attempt opened is therefore not the second's work.
    expect(
      adoptableFromAttempt({ kind: "implementation", attemptStartedAt: attemptStartOf(run), pr: { state: "open", createdAt: BEFORE } }),
    ).toBe(false);
  });

  it("falls back to the run's own start, then to when it was created", () => {
    expect(attemptStartOf({ ...base, startedAt: "2026-08-11T08:30:00.000Z" })).toBe("2026-08-11T08:30:00.000Z");
    expect(attemptStartOf(base)).toBe(base.createdAt);
  });
});

describe("planRunRecovery", () => {
  function lease(runId: string, kind: "implementation" | "follow-up" = "implementation"): RestoredLease {
    return { leaseId: `lease-${runId}`, runId, workerId: "wk-1", workerName: "bench-1", kind };
  }

  it("leaves a queued run alone when a restored lease still covers it", () => {
    // dispatch() issues the lease, but the run only leaves "queued" when the
    // worker's first run-patch lands, and a host can stop in between. The
    // lease is what is authoritative: queueing this again would hand the same
    // work to a second worker while the first is still running it.
    const plan = planRunRecovery([{ id: "run-1", status: "queued", createdAt: "2026-08-11T10:00:00.000Z" }], [lease("run-1")]);
    expect(plan.queue).toEqual([]);
    expect(plan.interrupted).toEqual([]);
    expect(plan.leased.map((entry) => entry.runId)).toEqual(["run-1"]);
  });

  it("queues a queued run that no lease covers", () => {
    const plan = planRunRecovery([{ id: "run-1", status: "queued", createdAt: "2026-08-11T10:00:00.000Z" }], []);
    expect(plan.queue).toEqual(["run-1"]);
    expect(plan.leased).toEqual([]);
    expect(plan.interrupted).toEqual([]);
  });

  it("interrupts a run that was executing with nothing left holding it", () => {
    const plan = planRunRecovery([{ id: "run-1", status: "running", createdAt: "2026-08-11T10:00:00.000Z" }], []);
    expect(plan.interrupted).toEqual(["run-1"]);
    expect(plan.queue).toEqual([]);
  });

  it("leaves a running run alone when its lease survived, whatever its kind", () => {
    const plan = planRunRecovery(
      [{ id: "run-1", status: "running", createdAt: "2026-08-11T10:00:00.000Z" }],
      [lease("run-1", "follow-up")],
    );
    expect(plan.interrupted).toEqual([]);
    expect(plan.leased.map((entry) => entry.kind)).toEqual(["follow-up"]);
  });

  it("queues in ascending queuedAt, whatever order the store listed them in", () => {
    const plan = planRunRecovery(
      [
        { id: "newest", status: "queued", createdAt: "2026-08-11T10:00:00.000Z", queuedAt: "2026-08-11T12:00:00.000Z" },
        { id: "oldest", status: "queued", createdAt: "2026-08-11T10:00:00.000Z", queuedAt: "2026-08-11T09:00:00.000Z" },
        { id: "middle", status: "queued", createdAt: "2026-08-11T10:00:00.000Z", queuedAt: "2026-08-11T11:00:00.000Z" },
      ],
      [],
    );
    expect(plan.queue).toEqual(["oldest", "middle", "newest"]);
  });

  it("sorts a mixed batch into exactly one bucket each", () => {
    const plan = planRunRecovery(
      [
        { id: "leased-queued", status: "queued", createdAt: "2026-08-11T10:00:00.000Z" },
        { id: "leased-running", status: "running", createdAt: "2026-08-11T10:00:00.000Z" },
        { id: "orphan-queued", status: "queued", createdAt: "2026-08-11T10:00:00.000Z" },
        { id: "orphan-running", status: "preparing", createdAt: "2026-08-11T10:00:00.000Z" },
      ],
      [lease("leased-queued"), lease("leased-running")],
    );
    expect(plan.leased.map((entry) => entry.runId).sort()).toEqual(["leased-queued", "leased-running"]);
    expect(plan.queue).toEqual(["orphan-queued"]);
    expect(plan.interrupted).toEqual(["orphan-running"]);
  });

  it("ignores a restored lease whose run is not among the pending ones", () => {
    const plan = planRunRecovery([], [lease("run-gone")]);
    expect(plan).toEqual({ leased: [], queue: [], interrupted: [] });
  });
});
