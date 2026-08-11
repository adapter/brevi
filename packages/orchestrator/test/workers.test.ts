import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configSchema,
  repoConfigSchema,
  WORKER_PROTOCOL_VERSION,
  type BreviConfig,
  type Run,
  type Ticket,
} from "@brevi/shared";
import { FakeSocket, flush } from "./fake-socket.js";
import { FleetStore } from "../src/fleet.js";
import { MemoryStore } from "../src/memory.js";
import { RunStore } from "../src/state.js";
import { WorkerRegistry } from "../src/workers.js";

// Run with `bun test packages/orchestrator` from the repo root (after
// `bun run build`, so the @brevi/shared import resolves to its dist output).
// Everything the host learns about a run now arrives over a worker socket, so
// these exercise the registry against a fake one: register, dispatch, report,
// complete, and the three ways that sequence is normally broken (a socket
// drop, a cancel while the owner is away, and a worker sending frames for a
// run its lease does not cover). Enrollment itself is enrollment.test.ts.

const ticket: Ticket = {
  id: "ticket-1",
  identifier: "PD-53",
  title: "Fleet 1",
  description: "Split scheduling from execution.",
  url: "https://linear.app/x/issue/PD-53",
  labels: ["brevi"],
  state: "In Progress",
  repo: "brevi",
  updatedAt: "2026-08-11T10:00:00.000Z",
};

const repo = repoConfigSchema.parse({ remote: "adapter/brevi" });

function capabilities(maxConcurrency = 2) {
  return {
    os: "linux",
    arch: "x64",
    provider: "firecracker" as const,
    kvm: true,
    maxConcurrency,
    vmSizes: ["small", "medium", "large"] as ("small" | "medium" | "large")[],
    version: "0.5.0",
  };
}

describe("WorkerRegistry", () => {
  let dir: string;
  let store: RunStore;
  let memories: MemoryStore;
  let fleet: FleetStore;
  let config: BreviConfig;
  let registry: WorkerRegistry;
  let settled: string[];
  let rejected: { runId: string; reason: string }[];
  /** The id the host assigned the enrolled worker, and the credential it minted for it. */
  let workerId: string;
  let credential: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "brevi-workers-"));
    store = new RunStore(join(dir, "runs"));
    await store.init();
    memories = new MemoryStore(join(dir, "memories"));
    await memories.init();
    fleet = new FleetStore(join(dir, "fleet.json"));
    await fleet.init();
    config = configSchema.parse({ fleet: { reconnectGraceSeconds: 3600 } });
    settled = [];
    rejected = [];
    workerId = "";
    credential = "";
    registry = new WorkerRegistry({
      config,
      store,
      memories,
      fleet,
      onRunSettled: (runId) => settled.push(runId),
      onRunRejected: (runId, reason) => rejected.push({ runId, reason }),
    });
  });

  afterEach(async () => {
    registry.stop();
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * Enroll one worker with a fresh pairing token and wait for the host to
   * answer. The id it ends up with is the host's to assign, so it is captured
   * here rather than chosen by the test.
   */
  async function connect(activeLeases: { id: string; runId: string; issuedAt: string }[] = []) {
    const { token } = fleet.mintPairingToken();
    const socket = new FakeSocket();
    registry.accept(socket.asWebSocket(), "127.0.0.1");
    socket.receive({
      type: "register",
      protocolVersion: WORKER_PROTOCOL_VERSION,
      auth: { kind: "pairing", token },
      name: "bench-1",
      capabilities: capabilities(),
      activeLeases,
    });
    await flush();
    const registered = socket.last("registered");
    workerId = registered?.workerId ?? "";
    credential = registered?.credential ?? "";
    return socket;
  }

  /** Bring the same enrollment back on a new socket, authenticating with its stored credential. */
  async function reconnect(activeLeases: { id: string; runId: string; issuedAt: string }[] = []) {
    const socket = new FakeSocket();
    registry.accept(socket.asWebSocket(), "127.0.0.1");
    socket.receive({
      type: "register",
      protocolVersion: WORKER_PROTOCOL_VERSION,
      auth: { kind: "credential", workerId, secret: credential },
      name: "bench-1",
      capabilities: capabilities(),
      activeLeases,
    });
    await flush();
    return socket;
  }

  async function queueRun(): Promise<Run> {
    return store.createRun(ticket);
  }

  function dispatch(run: Run): boolean {
    return registry.dispatch({
      kind: "implementation",
      run,
      repoKey: "brevi",
      repo,
      config,
      prompts: { prDescription: "concise", memories: [], recordMemories: false },
    });
  }

  it("registers a worker and dispatches a run to it", async () => {
    const socket = await connect();
    expect(socket.last("registered")?.protocolVersion).toBe(WORKER_PROTOCOL_VERSION);
    expect(registry.list()).toHaveLength(1);
    expect(registry.capacity()).toBe(2);

    const run = await queueRun();
    expect(dispatch(run)).toBe(true);

    const sent = socket.last("dispatch");
    expect(sent).toBeDefined();
    expect(sent?.run.id).toBe(run.id);
    expect(sent?.repoKey).toBe("brevi");
    expect(sent?.prompts.prDescription).toBe("concise");
    expect(registry.inFlight()).toBe(1);

    // The host, not the worker, records who owns the run.
    await flush();
    expect(store.get(run.id)?.sandbox.workerId).toBe(workerId);
  });

  it("refuses a worker whose pairing token is wrong", async () => {
    const socket = new FakeSocket();
    registry.accept(socket.asWebSocket(), "127.0.0.1");
    socket.receive({
      type: "register",
      protocolVersion: WORKER_PROTOCOL_VERSION,
      auth: { kind: "pairing", token: "not-the-token" },
      name: "impostor",
      capabilities: capabilities(),
      activeLeases: [],
    });
    await flush();
    expect(socket.last("rejected")?.code).toBe("invalid-token");
    // Nothing was enrolled, so the fleet is still empty rather than holding a
    // record for a machine that never got in.
    expect(registry.list()).toHaveLength(0);
  });

  it("refuses a register frame from an unsupported protocol version", async () => {
    const socket = new FakeSocket();
    const { token } = fleet.mintPairingToken();
    registry.accept(socket.asWebSocket(), "127.0.0.1");
    socket.receive({
      type: "register",
      protocolVersion: WORKER_PROTOCOL_VERSION + 1,
      auth: { kind: "pairing", token },
      name: "from-the-future",
      capabilities: capabilities(),
      activeLeases: [],
    });
    await flush();
    expect(socket.last("rejected")?.code).toBe("protocol");
    // The version check runs before the token is looked at, so it is still
    // unspent and the operator's copied command keeps working.
    expect(registry.list()).toHaveLength(0);
  });

  it("keeps the run's owner across sandbox reports, then attaches and discards through that worker", async () => {
    const socket = await connect();
    const run = await queueRun();
    dispatch(run);
    await flush();
    const lease = socket.last("dispatch")!.lease;

    // The worker reports its sandbox: a merge, so the owner survives.
    socket.receive({
      type: "run-patch",
      leaseId: lease.id,
      runId: run.id,
      patch: { status: "running", sandbox: { provider: "firecracker", id: "vm-1" } },
    });
    await flush();
    expect(store.get(run.id)?.sandbox).toMatchObject({
      provider: "firecracker",
      id: "vm-1",
      workerId,
    });

    // A destroyed sandbox retracts its id, and only its id: the owner and
    // the provider the worker reported stay exactly as they were.
    socket.receive({ type: "run-patch", leaseId: lease.id, runId: run.id, patch: { sandbox: { id: null } } });
    await flush();
    expect(store.get(run.id)?.sandbox).toEqual({ provider: "firecracker", workerId });
    socket.receive({ type: "run-patch", leaseId: lease.id, runId: run.id, patch: { sandbox: { id: "vm-1" } } });
    await flush();

    socket.receive({
      type: "run-complete",
      leaseId: lease.id,
      runId: run.id,
      outcome: "completed",
      finishedAt: "2026-08-11T10:30:00.000Z",
      result: { summary: "done", prUrl: "https://github.com/adapter/brevi/pull/1", artifacts: [] },
      artifacts: [],
      prUrl: "https://github.com/adapter/brevi/pull/1",
      prState: "open",
      attempts: [],
      costs: [],
      sandbox: { retainedUntil: "2026-08-11T12:30:00.000Z" },
    });
    await flush();

    const finished = store.get(run.id)!;
    expect(finished.status).toBe("completed");
    expect(finished.result?.prUrl).toBe("https://github.com/adapter/brevi/pull/1");
    expect(finished.sandbox.retainedUntil).toBe("2026-08-11T12:30:00.000Z");
    // Still owned: attach routing and the reaper both resolve the worker from it.
    expect(finished.sandbox.workerId).toBe(workerId);
    expect(settled).toEqual([run.id]);
    expect(socket.ofType("run-complete-ack")).toHaveLength(1);
    expect(registry.inFlight()).toBe(0);

    expect(registry.workerFor(run.id)?.id).toBe(workerId);
    const session = registry.openAttach(run.id, {
      cols: 80,
      rows: 24,
      onData: () => {},
      onExit: () => {},
      onError: () => {},
    });
    expect(session).toBeDefined();
    expect(socket.last("attach-open")?.runId).toBe(run.id);
    expect(registry.hasAttachSession(run.id)).toBe(true);
    session?.close();
    expect(registry.hasAttachSession(run.id)).toBe(false);

    expect(registry.discard(run.id)).toBe(true);
    expect(socket.last("discard")?.runId).toBe(run.id);
  });

  it("ignores lease-scoped frames that name another run", async () => {
    const socket = await connect();
    const mine = await queueRun();
    const other = await queueRun();
    dispatch(mine);
    await flush();
    const lease = socket.last("dispatch")!.lease;

    // One valid lease must never be usable to mutate a different run.
    socket.receive({
      type: "run-patch",
      leaseId: lease.id,
      runId: other.id,
      patch: { status: "failed", error: "not mine to write" },
    });
    socket.receive({
      type: "run-event",
      leaseId: lease.id,
      runId: other.id,
      event: { runId: other.id, ts: "2026-08-11T10:00:00.000Z", type: "log", stream: "system", text: "nope" },
    });
    socket.receive({
      type: "run-artifact",
      leaseId: lease.id,
      runId: other.id,
      artifact: { name: "demo.png", type: "screenshot", size: 3 },
      data: Buffer.from("png").toString("base64"),
    });
    socket.receive({
      type: "dispatch-rejected",
      leaseId: lease.id,
      runId: other.id,
      reason: "not mine to reject",
    });
    await flush();

    expect(store.get(other.id)?.status).toBe("queued");
    expect(store.get(other.id)?.error).toBeUndefined();
    expect(await store.readEvents(other.id)).toHaveLength(1); // just its own "queued" status event
    expect(rejected).toEqual([]);
    expect(registry.inFlight()).toBe(1); // the mismatched frames settled nothing

    // A completion for another run is refused the same way.
    socket.receive({
      type: "run-complete",
      leaseId: lease.id,
      runId: other.id,
      outcome: "completed",
      artifacts: [],
      attempts: [],
      costs: [],
    });
    await flush();
    expect(store.get(other.id)?.status).toBe("queued");
    expect(store.get(mine.id)?.status).toBe("queued");
    expect(settled).toEqual([]);
    expect(registry.inFlight()).toBe(1);
  });

  it("replays a completion buffered across a disconnect instead of failing the run", async () => {
    const socket = await connect();
    const run = await queueRun();
    dispatch(run);
    await flush();
    const lease = socket.last("dispatch")!.lease;

    socket.receive({ type: "run-patch", leaseId: lease.id, runId: run.id, patch: { status: "running" } });
    await flush();

    // The socket drops the instant before the run's completion would have
    // been sent. The worker keeps claiming the lease because the host never
    // acknowledged the completion.
    socket.drop();
    expect(store.get(run.id)?.status).toBe("running");

    const reconnected = await reconnect([{ id: lease.id, runId: run.id, issuedAt: lease.issuedAt }]);
    reconnected.receive({
      type: "run-complete",
      leaseId: lease.id,
      runId: run.id,
      outcome: "completed",
      finishedAt: "2026-08-11T10:30:00.000Z",
      result: { summary: "done", prUrl: "https://github.com/adapter/brevi/pull/2", artifacts: [] },
      artifacts: [],
      prUrl: "https://github.com/adapter/brevi/pull/2",
      prState: "open",
      attempts: [],
      costs: [{ label: "implementation", provider: "claude", inputTokens: 10, outputTokens: 20 }],
      costTotals: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimated: false,
      },
    });
    await flush();

    const finished = store.get(run.id)!;
    expect(finished.status).toBe("completed");
    expect(finished.error).toBeUndefined();
    expect(finished.result?.prUrl).toBe("https://github.com/adapter/brevi/pull/2");
    expect(finished.prState).toBe("open");
    expect(finished.costs).toHaveLength(1);
    expect(settled).toEqual([run.id]);
    expect(reconnected.ofType("run-complete-ack")).toHaveLength(1);
  });

  it("delivers a cancellation requested while the owning worker was away", async () => {
    const socket = await connect();
    const run = await queueRun();
    dispatch(run);
    await flush();
    const lease = socket.last("dispatch")!.lease;
    socket.receive({ type: "run-patch", leaseId: lease.id, runId: run.id, patch: { status: "running" } });
    await flush();

    socket.drop();
    // Inside the reconnect grace window: the lease is still alive, so the
    // cancellation is recorded rather than lost.
    expect(registry.cancel(run.id)).toBe("pending");
    expect(store.get(run.id)?.status).toBe("running");

    const reconnected = await reconnect([{ id: lease.id, runId: run.id, issuedAt: lease.issuedAt }]);
    await flush();
    const cancels = reconnected.ofType("cancel");
    expect(cancels).toHaveLength(1);
    expect(cancels[0]?.leaseId).toBe(lease.id);
    expect(cancels[0]?.runId).toBe(run.id);

    reconnected.receive({
      type: "run-complete",
      leaseId: lease.id,
      runId: run.id,
      outcome: "cancelled",
      finishedAt: "2026-08-11T10:05:00.000Z",
      artifacts: [],
      attempts: [],
      costs: [],
    });
    await flush();
    expect(store.get(run.id)?.status).toBe("cancelled");
    // The intent is spent: a fresh lease must not inherit it.
    expect(registry.cancel(run.id)).toBe("unknown");
  });

  it("cancels a connected worker's run directly", async () => {
    const socket = await connect();
    const run = await queueRun();
    dispatch(run);
    await flush();
    expect(registry.cancel(run.id)).toBe("sent");
    expect(socket.last("cancel")?.runId).toBe(run.id);
    expect(registry.cancel("no-such-run")).toBe("unknown");
  });

  it("saves a transferred artifact once and logs one that never arrived", async () => {
    const socket = await connect();
    const run = await queueRun();
    dispatch(run);
    await flush();
    const lease = socket.last("dispatch")!.lease;

    socket.receive({
      type: "run-artifact",
      leaseId: lease.id,
      runId: run.id,
      artifact: { name: "demo.png", type: "screenshot", size: 3 },
      data: Buffer.from("png").toString("base64"),
    });
    await flush();

    socket.receive({
      type: "run-complete",
      leaseId: lease.id,
      runId: run.id,
      outcome: "completed",
      artifacts: [
        { name: "demo.png", type: "screenshot", size: 3 },
        { name: "lost.webm", type: "recording", size: 9 },
      ],
      attempts: [],
      costs: [],
    });
    await flush();

    const events = await store.readEvents(run.id);
    // Exactly one artifact event for the transferred file: the host appends
    // it when it saves the bytes, and the worker no longer sends its own.
    expect(events.filter((event) => event.type === "artifact")).toHaveLength(1);
    const logs = events.filter((event) => event.type === "log").map((event) => event.text);
    expect(logs.some((text) => text.includes("lost.webm"))).toBe(true);
  });

  it("applies a completion once when the worker replays it before the ack lands", async () => {
    const socket = await connect();
    const run = await queueRun();
    dispatch(run);
    await flush();
    const lease = socket.last("dispatch")!.lease;

    const completion = {
      type: "run-complete" as const,
      leaseId: lease.id,
      runId: run.id,
      outcome: "completed" as const,
      finishedAt: "2026-08-11T10:30:00.000Z",
      artifacts: [],
      attempts: [],
      costs: [],
    };
    // A worker holds its completion until the host acknowledges it, so it
    // legitimately replays one whose ack was lost. Both copies can arrive
    // before the first has finished settling the lease.
    socket.receive(completion);
    socket.receive(completion);
    await flush();

    expect(store.get(run.id)?.status).toBe("completed");
    expect(socket.ofType("run-complete-ack")).toHaveLength(1);
    expect(settled).toEqual([run.id]);
    const statusEvents = (await store.readEvents(run.id)).filter(
      (event) => event.type === "status" && event.status === "completed",
    );
    expect(statusEvents).toHaveLength(1);
  });

  it("saves an artifact sent immediately before the completion that lists it", async () => {
    const socket = await connect();
    const run = await queueRun();
    dispatch(run);
    await flush();
    const lease = socket.last("dispatch")!.lease;

    // Back to back, with nothing awaited in between: a worker finishing a run
    // sends its last artifact and its completion in the same breath. Both
    // handlers are async, so without ordering the completion reconciles the
    // manifest while the bytes are still being written and reports a file
    // that did in fact arrive as lost.
    socket.receive({
      type: "run-artifact",
      leaseId: lease.id,
      runId: run.id,
      artifact: { name: "demo.png", type: "screenshot", size: 3 },
      data: Buffer.from("png").toString("base64"),
    });
    socket.receive({
      type: "run-complete",
      leaseId: lease.id,
      runId: run.id,
      outcome: "completed",
      artifacts: [{ name: "demo.png", type: "screenshot", size: 3 }],
      attempts: [],
      costs: [],
    });
    await flush();

    const events = await store.readEvents(run.id);
    expect(events.filter((event) => event.type === "artifact")).toHaveLength(1);
    const logs = events.filter((event) => event.type === "log").map((event) => event.text);
    expect(logs.some((text) => text.includes("did not reach the host"))).toBe(false);
    expect(store.get(run.id)?.status).toBe("completed");
  });
});
