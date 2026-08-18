import { describe, expect, test } from "bun:test";
import type { OrchestratorHandle } from "@brevi/orchestrator";
import { OrchestratorSupervisor } from "../src/main/supervisor.js";

function handle(onStop: () => void): OrchestratorHandle {
  return {
    port: 4400,
    url: "http://127.0.0.1:4400",
    ensureLocalWorker: async () => ({ workerId: "unused", credential: "unused" }),
    stop: async () => onStop(),
  };
}

describe("OrchestratorSupervisor", () => {
  test("owns the in-process orchestrator lifecycle", async () => {
    let starts = 0;
    let stops = 0;
    const states: string[] = [];
    const supervisor = new OrchestratorSupervisor({
      startOrchestrator: async () => {
        starts += 1;
        return handle(() => {
          stops += 1;
        });
      },
      onState: (state) => states.push(state.kind),
    });

    await supervisor.start();
    expect(supervisor.state.kind).toBe("running");
    expect(supervisor.ownsProcess).toBe(true);
    expect(supervisor.pid).toBe(process.pid);

    await supervisor.restart();
    expect(starts).toBe(2);
    expect(stops).toBe(1);

    await supervisor.stop();
    expect(stops).toBe(2);
    expect(supervisor.state.kind).toBe("stopped");
    expect(states).toEqual(["starting", "running", "starting", "running", "stopped"]);
  });

  test("reports startup failures without leaving a handle", async () => {
    const supervisor = new OrchestratorSupervisor({
      startOrchestrator: async () => {
        throw new Error("port unavailable");
      },
    });
    await supervisor.start();
    expect(supervisor.state).toEqual({ kind: "failed", reason: "port unavailable" });
    expect(supervisor.ownsProcess).toBe(false);
  });
});
