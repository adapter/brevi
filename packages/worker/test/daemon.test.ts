import { spawnSync } from "node:child_process";
import { describe, expect, it } from "bun:test";
import { resolveEnrollment, watchSupervisor } from "../src/daemon.js";

// Run with `bun test packages/worker` from the repo root. Neither suite here
// touches the filesystem: resolveEnrollment is exercised with spies standing
// in for identity.ts (WORKER_STATE_PATH resolves from the real home at
// import time, so spies are the only safe seam), and watchSupervisor only
// probes pids with a zero signal.

/** Polls `predicate` instead of a fixed sleep, mirroring connection.test.ts's helper. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for condition after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A pid nothing owns any more: spawnSync blocks until the child has fully exited and been reaped, so this is deterministic rather than racing a still-live zombie. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  if (result.pid === undefined) throw new Error("could not spawn a throwaway child to get a dead pid from");
  return result.pid;
}

describe("resolveEnrollment", () => {
  it("uses an injected enrollment as-is and never calls into identity.ts", async () => {
    const calls: string[] = [];
    const identity = {
      enrollmentFor: async (hostUrl: string) => {
        calls.push(`enrollmentFor:${hostUrl}`);
        return undefined;
      },
      saveEnrollment: async () => {
        calls.push("saveEnrollment");
      },
      clearEnrollment: async () => {
        calls.push("clearEnrollment");
      },
    };

    const result = await resolveEnrollment(
      { enrollment: { workerId: "wk-injected", credential: "bwc_injected" }, hostUrl: "http://127.0.0.1:4400" },
      identity,
    );

    expect(result.enrollment).toEqual({
      workerId: "wk-injected",
      credential: "bwc_injected",
      host: "http://127.0.0.1:4400",
    });

    // Both callbacks a real enrollment would use to touch disk are no-ops
    // for an injected one; invoking them must not reach identity.ts either.
    await result.onEnrolled({ workerId: "wk-injected", credential: "bwc_injected", host: "http://127.0.0.1:4400" });
    await result.clearOnRevoke();
    expect(calls).toEqual([]);
  });

  it("falls back to the stored enrollment and wires persistence through identity.ts when nothing is injected", async () => {
    const calls: string[] = [];
    const stored = { workerId: "wk-stored", credential: "bwc_stored", host: "http://127.0.0.1:4400" };
    const identity = {
      enrollmentFor: async (hostUrl: string) => {
        calls.push(`enrollmentFor:${hostUrl}`);
        return stored;
      },
      saveEnrollment: async (record: typeof stored) => {
        calls.push(`saveEnrollment:${record.workerId}`);
      },
      clearEnrollment: async () => {
        calls.push("clearEnrollment");
      },
    };

    const result = await resolveEnrollment({ hostUrl: "http://127.0.0.1:4400" }, identity);

    expect(result.enrollment).toEqual(stored);
    expect(calls).toEqual(["enrollmentFor:http://127.0.0.1:4400"]);

    await result.onEnrolled({ workerId: "wk-fresh", credential: "bwc_fresh", host: "http://127.0.0.1:4400" });
    await result.clearOnRevoke();
    expect(calls).toEqual(["enrollmentFor:http://127.0.0.1:4400", "saveEnrollment:wk-fresh", "clearEnrollment"]);
  });
});

describe("watchSupervisor", () => {
  it("fires onGone once for a pid that is already gone", async () => {
    const pid = deadPid();
    let calls = 0;
    const stop = watchSupervisor(pid, () => calls++, 20);
    try {
      await waitFor(() => calls > 0);
      expect(calls).toBe(1);
      // Fires only once: the interval clears itself the moment it detects
      // the pid is gone, so waiting past several more polling intervals
      // must not call onGone again.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(calls).toBe(1);
    } finally {
      stop();
    }
  });

  it("never fires onGone while the pid stays alive", async () => {
    let calls = 0;
    // process.pid: this test process itself, guaranteed alive for the
    // duration of the test.
    const stop = watchSupervisor(process.pid, () => calls++, 20);
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(calls).toBe(0);
    } finally {
      stop();
    }
  });

  it("stops polling once the returned function is called", async () => {
    const pid = deadPid();
    let calls = 0;
    const stop = watchSupervisor(pid, () => calls++, 20);
    stop();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls).toBe(0);
  });
});
