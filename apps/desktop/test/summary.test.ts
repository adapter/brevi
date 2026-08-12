import { describe, expect, test } from "bun:test";
import type { Run, RunStatus, Ticket } from "@brevi/shared";
import {
  countRuns,
  fleetLine,
  menuRuns,
  orchestratorVersionLine,
  runLabel,
  runningCount,
  updateBlockingRuns,
  workerLine,
} from "../src/main/summary.js";
import type { SupervisorState } from "../src/main/supervisor.js";

function ticket(identifier: string): Ticket {
  return {
    id: identifier,
    identifier,
    title: `Fix the ${identifier} thing`,
    description: "",
    url: `https://linear.app/team/issue/${identifier}`,
    labels: ["brevi"],
    state: "Todo",
    updatedAt: "2026-08-11T00:00:00.000Z",
  };
}

function run(id: string, status: RunStatus, opts: Partial<Run> = {}): Run {
  return {
    id,
    ticket: ticket(id),
    status,
    sandbox: { provider: "process" },
    createdAt: "2026-08-11T00:00:00.000Z",
    attempts: [],
    costs: [],
    ...opts,
  };
}

describe("countRuns", () => {
  test("buckets active, queued, waiting and failed runs", () => {
    const runs = [
      run("a", "running"),
      run("b", "queued"),
      run("c", "queued"),
      run("d", "waiting"),
      run("e", "failed"),
      run("f", "completed"),
      run("g", "cancelled"),
    ];
    expect(countRuns(runs)).toEqual({
      // active covers queued + waiting + running (see ACTIVE_STATUSES)
      active: 4,
      queued: 2,
      waiting: 1,
      failed: 1,
      total: 7,
    });
  });

  test("is all zero for an empty fleet", () => {
    expect(countRuns([])).toEqual({ active: 0, queued: 0, waiting: 0, failed: 0, total: 0 });
  });
});

describe("runningCount", () => {
  test("subtracts queued and waiting out of active", () => {
    expect(runningCount({ active: 4, queued: 2, waiting: 1, failed: 0, total: 7 })).toBe(1);
  });

  test("is zero for an idle fleet", () => {
    expect(runningCount({ active: 0, queued: 0, waiting: 0, failed: 0, total: 0 })).toBe(0);
  });

  test("clamps at zero rather than going negative", () => {
    expect(runningCount({ active: 1, queued: 2, waiting: 2, failed: 0, total: 5 })).toBe(0);
  });
});

describe("updateBlockingRuns", () => {
  test("counts running and queued runs together", () => {
    expect(updateBlockingRuns({ active: 4, queued: 2, waiting: 1, failed: 0, total: 7 })).toBe(3);
  });

  test("queued runs alone block an install: stopping the orchestrator cancels them", () => {
    const counts = countRuns([run("a", "queued"), run("b", "queued")]);
    expect(runningCount(counts)).toBe(0);
    expect(updateBlockingRuns(counts)).toBe(2);
  });

  test("waiting runs never block: a restart reschedules them", () => {
    expect(updateBlockingRuns(countRuns([run("a", "waiting")]))).toBe(0);
  });

  test("is zero for an idle fleet", () => {
    expect(updateBlockingRuns(countRuns([run("a", "completed"), run("b", "failed")]))).toBe(0);
  });

  test("clamps at zero rather than going negative", () => {
    expect(updateBlockingRuns({ active: 1, queued: 0, waiting: 2, failed: 0, total: 3 })).toBe(0);
  });
});

describe("fleetLine", () => {
  test("reports idle with no work anywhere in the pipeline", () => {
    expect(fleetLine(countRuns([]))).toBe("Idle");
  });

  test("splits active back into running, queued and waiting", () => {
    const runs = [run("a", "running"), run("b", "queued"), run("c", "queued"), run("d", "queued")];
    expect(fleetLine(countRuns(runs))).toBe("1 running, 3 queued");
  });

  test("mentions waiting runs separately from queued ones", () => {
    const runs = [run("a", "waiting"), run("b", "queued")];
    expect(fleetLine(countRuns(runs))).toBe("1 queued, 1 waiting");
  });
});

describe("workerLine", () => {
  test("running: names the pid the supervisor owns", () => {
    const state: SupervisorState = { kind: "running", pid: 4021 };
    expect(workerLine(state)).toBe("Orchestrator: running (pid 4021)");
  });

  test("attached: names the pid of a CLI instance we didn't start", () => {
    const state: SupervisorState = { kind: "attached", pid: 918 };
    expect(workerLine(state)).toBe("Orchestrator: attached to CLI (pid 918)");
  });

  test("attached: tolerates an unknown pid", () => {
    const state: SupervisorState = { kind: "attached", pid: null };
    expect(workerLine(state)).toBe("Orchestrator: attached to CLI");
  });

  test("restarting: rounds the delay up to whole seconds", () => {
    const state: SupervisorState = { kind: "restarting", attempt: 2, delayMs: 3_400, reason: "crashed" };
    expect(workerLine(state)).toBe("Orchestrator: restarting in 4s (attempt 2)");
  });

  test("failed: surfaces the reason", () => {
    const state: SupervisorState = { kind: "failed", reason: "port 4400 already in use" };
    expect(workerLine(state)).toBe("Orchestrator: failed (port 4400 already in use)");
  });
});

describe("orchestratorVersionLine", () => {
  test("null when not attached", () => {
    expect(orchestratorVersionLine("1.2.0", false, "1.1.0")).toBeNull();
  });

  test("null when attached but the orchestrator version is unknown", () => {
    expect(orchestratorVersionLine("1.2.0", true, undefined)).toBeNull();
  });

  test("null when attached and versions match", () => {
    expect(orchestratorVersionLine("1.2.0", true, "1.2.0")).toBeNull();
  });

  test("reports both versions when attached to a mismatched orchestrator", () => {
    expect(orchestratorVersionLine("1.2.0", true, "1.1.0")).toBe("Version: app 1.2.0, attached orchestrator 1.1.0");
  });
});

describe("menuRuns", () => {
  test("leads with the runs furthest along, then recent finished ones", () => {
    const runs = [
      run("old-done", "completed", { createdAt: "2026-08-01T00:00:00.000Z", finishedAt: "2026-08-01T00:10:00.000Z" }),
      run("new-queued", "queued", { createdAt: "2026-08-10T00:00:00.000Z" }),
      run("recent-done", "failed", { createdAt: "2026-08-09T00:00:00.000Z", finishedAt: "2026-08-09T00:10:00.000Z" }),
      run("old-running", "running", { createdAt: "2026-08-05T00:00:00.000Z" }),
    ];
    const ordered = menuRuns(runs, 10).map((r) => r.id);
    expect(ordered).toEqual(["old-running", "new-queued", "recent-done", "old-done"]);
  });

  test("orders runs at the same stage newest first", () => {
    const runs = [
      run("older", "running", { createdAt: "2026-08-05T00:00:00.000Z" }),
      run("newer", "running", { createdAt: "2026-08-06T00:00:00.000Z" }),
    ];
    expect(menuRuns(runs, 10).map((r) => r.id)).toEqual(["newer", "older"]);
  });

  test("caps the result at limit", () => {
    const runs = [run("a", "running"), run("b", "queued"), run("c", "waiting")];
    expect(menuRuns(runs, 2)).toHaveLength(2);
  });
});

describe("runLabel", () => {
  test("pairs the ticket identifier with the status label", () => {
    expect(runLabel(run("x", "running"))).toBe("x  Running");
  });
});
