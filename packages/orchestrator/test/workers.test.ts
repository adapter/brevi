import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
import { LeaseStore } from "../src/leases.js";
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

interface CapabilitiesOverrides {
  provider?: "firecracker" | "process";
  maxConcurrency?: number;
  vmSizes?: ("small" | "medium" | "large")[];
}

function capabilities(overrides: CapabilitiesOverrides = {}) {
  return {
    os: "linux",
    arch: "x64",
    provider: overrides.provider ?? "firecracker",
    kvm: true,
    maxConcurrency: overrides.maxConcurrency ?? 2,
    vmSizes: overrides.vmSizes ?? (["small", "medium", "large"] as ("small" | "medium" | "large")[]),
    version: "0.5.0",
  };
}

describe("WorkerRegistry", () => {
  let dir: string;
  let store: RunStore;
  let memories: MemoryStore;
  let fleet: FleetStore;
  let config: BreviConfig;
  let leasesPath: string;
  let registry: WorkerRegistry;
  let settled: string[];
  let rejected: { runId: string; reason: string }[];
  let interrupted: { runId: string; reason: string; kind: string }[];
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
    leasesPath = join(dir, "fleet", "leases.json");
    settled = [];
    rejected = [];
    interrupted = [];
    workerId = "";
    credential = "";
    registry = new WorkerRegistry({
      config,
      store,
      memories,
      fleet,
      leases: new LeaseStore(leasesPath),
      onRunSettled: (runId) => settled.push(runId),
      onRunRejected: (runId, reason) => rejected.push({ runId, reason }),
      onRunInterrupted: (runId, reason, kind) => interrupted.push({ runId, reason, kind }),
    });
  });

  afterEach(async () => {
    await registry.stop();
    // A dispatch queues a run-store write that isn't awaited by the caller,
    // and so do the lease-write chains behind a run's frames. Draining them
    // before the directory goes away keeps a late write from failing against
    // a path that no longer exists: that surfaces as an unhandled ENOENT
    // attributed to whichever test happens to be running next. Mirrors
    // enrollment.test.ts.
    await registry.drain();
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * Enroll one worker with a fresh pairing token and wait for the host to
   * answer. The id and the name it ends up with are the host's to assign, so
   * both are read back off the `registered` frame rather than chosen here.
   */
  async function enroll(name: string, capsOverrides: CapabilitiesOverrides = {}) {
    const { token } = fleet.mintPairingToken();
    const socket = new FakeSocket();
    registry.accept(socket.asWebSocket(), "127.0.0.1");
    socket.receive({
      type: "register",
      protocolVersion: WORKER_PROTOCOL_VERSION,
      auth: { kind: "pairing", token },
      name,
      capabilities: capabilities(capsOverrides),
      activeLeases: [],
    });
    await flush();
    const registered = socket.last("registered");
    return {
      socket,
      id: registered?.workerId ?? "",
      name: registered?.name ?? "",
      credential: registered?.credential ?? "",
    };
  }

  /**
   * Enroll the one worker most tests use, capturing its identity in the outer
   * `workerId` / `credential` so `reconnect` can come back as it.
   */
  async function connect(capsOverrides: CapabilitiesOverrides = {}) {
    const worker = await enroll("bench-1", capsOverrides);
    workerId = worker.id;
    credential = worker.credential;
    return worker.socket;
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

  function dispatch(run: Run, vmSize?: "small" | "medium" | "large") {
    return registry.dispatch({
      kind: "implementation",
      run,
      repoKey: "brevi",
      repo,
      config,
      prompts: { prDescription: "concise", memories: [], recordMemories: false },
      vmSize,
    });
  }

  it("registers a worker and dispatches a run to it", async () => {
    const socket = await connect();
    expect(socket.last("registered")?.protocolVersion).toBe(WORKER_PROTOCOL_VERSION);
    expect(registry.list()).toHaveLength(1);
    expect(registry.capacity()).toBe(2);

    const run = await queueRun();
    const outcome = dispatch(run);
    expect(outcome).toEqual({ placed: true, workerId, workerName: "bench-1" });

    // The frame only goes out once the lease is on disk, so the outcome is
    // immediate but the dispatch itself is one write away.
    expect(socket.last("dispatch")).toBeUndefined();
    await flush();
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

  it("reports a worker's demand: connected with its lease count after a dispatch, unknown otherwise", async () => {
    await connect();
    const run = await queueRun();
    expect(dispatch(run)).toMatchObject({ placed: true });

    expect(registry.workerDemand(workerId)).toEqual({
      id: workerId,
      connected: true,
      state: "active",
      activeRuns: 1,
      attachSessions: 0,
    });
    expect(registry.spareCapacity()).toBe(1);

    // An id the host has no record of reads as draining: whatever it is, the
    // scheduler will not dispatch to it, so a supervisor asking on its behalf
    // must not be told to boot a machine.
    expect(registry.workerDemand("no-such-worker")).toEqual({
      id: "no-such-worker",
      connected: false,
      state: "draining",
      activeRuns: 0,
      attachSessions: 0,
    });
  });

  it("reports a drained worker's state in its demand, and drops it from spare capacity", async () => {
    await connect();
    expect(registry.spareCapacity()).toBe(2);

    expect(await registry.setState(workerId, "draining")).toBe(true);

    const demand = registry.workerDemand(workerId);
    expect(demand.state).toBe("draining");
    // Still connected, and still reported: draining is "accept nothing new",
    // not "gone". What changes is that its idle slots stop counting as room
    // the scheduler may plan against.
    expect(demand.connected).toBe(true);
    expect(registry.spareCapacity()).toBe(0);

    expect(await registry.setState(workerId, "active")).toBe(true);
    expect(registry.workerDemand(workerId).state).toBe("active");
    expect(registry.spareCapacity()).toBe(2);
  });

  it("authenticates a worker's durable credential, and nothing else", async () => {
    await connect();
    expect(registry.authenticate(workerId, credential)).toBe(true);
    expect(registry.authenticate(workerId, "not-the-credential")).toBe(false);
    expect(registry.authenticate("no-such-worker", credential)).toBe(false);
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


  // --- placement -------------------------------------------------------

  it("prefers a Firecracker worker over a process one, and falls back to the process worker once Firecracker is full", async () => {
    const fc = await enroll("fc-1", { provider: "firecracker", maxConcurrency: 1 });
    const proc = await enroll("proc-1", { provider: "process", maxConcurrency: 2, vmSizes: [] });

    const first = await queueRun();
    expect(dispatch(first)).toEqual({ placed: true, workerId: fc.id, workerName: fc.name });
    await flush();
    expect(fc.socket.last("dispatch")?.run.id).toBe(first.id);

    // Firecracker is now at capacity (maxConcurrency 1); the process worker
    // is the only one left with room.
    const second = await queueRun();
    expect(dispatch(second)).toEqual({ placed: true, workerId: proc.id, workerName: proc.name });
    await flush();
    expect(proc.socket.last("dispatch")?.run.id).toBe(second.id);
  });

  it("respects maxConcurrency, and the outcome's reason names capacity once every connected worker is full", async () => {
    await connect({ maxConcurrency: 1 });
    const first = await queueRun();
    expect(dispatch(first)).toMatchObject({ placed: true });
    await flush();

    const second = await queueRun();
    expect(dispatch(second)).toEqual({ placed: false, reason: "all 1 connected worker is at capacity" });
    await flush();
  });

  it("refuses a run asking for a vmSize no connected Firecracker worker advertises", async () => {
    await connect({ provider: "firecracker", vmSizes: ["small"] });
    const run = await queueRun();
    expect(dispatch(run, "large")).toEqual({ placed: false, reason: "no connected worker can boot a large VM" });
    await flush();
  });

  it("never places a run on a draining worker, and says so when that is the only one connected", async () => {
    const worker = await enroll("drained-1");
    await registry.setState(worker.id, "draining");

    const run = await queueRun();
    expect(dispatch(run)).toEqual({ placed: false, reason: "the 1 connected worker is draining" });
    await flush();

    // Re-enabled, the same worker takes the run normally.
    await registry.setState(worker.id, "active");
    expect(dispatch(run)).toEqual({ placed: true, workerId: worker.id, workerName: worker.name });
  });

  // --- lease expiry ------------------------------------------------------

  it("expires a lease when its worker stops reporting, and hands the run to onRunInterrupted instead of failing it", async () => {
    // A short reconnectGraceSeconds so the disconnect's grace timer actually
    // fires within the test; bypasses configSchema's 10s floor on purpose.
    const fastConfig: BreviConfig = { ...config, fleet: { ...config.fleet, reconnectGraceSeconds: 0.1 } };
    const localInterrupted: { runId: string; reason: string; kind: string }[] = [];
    const fastFleet = new FleetStore(join(dir, "fleet-fast.json"));
    await fastFleet.init();
    const fastRegistry = new WorkerRegistry({
      config: fastConfig,
      store,
      memories,
      fleet: fastFleet,
      leases: new LeaseStore(join(dir, "fleet-fast", "leases.json")),
      onRunSettled: () => {},
      onRunRejected: () => {},
      onRunInterrupted: (runId, reason, kind) => localInterrupted.push({ runId, reason, kind }),
    });
    try {
      const { token } = fastFleet.mintPairingToken();
      const socket = new FakeSocket();
      fastRegistry.accept(socket.asWebSocket(), "127.0.0.1");
      socket.receive({
        type: "register",
        protocolVersion: WORKER_PROTOCOL_VERSION,
        auth: { kind: "pairing", token },
        name: "bench-fast",
        capabilities: capabilities(),
        activeLeases: [],
      });
      await flush();

      const run = await queueRun();
      const outcome = fastRegistry.dispatch({
        kind: "implementation",
        run,
        repoKey: "brevi",
        repo,
        config,
        prompts: { prDescription: "concise", memories: [], recordMemories: false },
      });
      expect(outcome).toMatchObject({ placed: true });

      socket.drop();
      await new Promise((resolve) => setTimeout(resolve, 400));

      expect(localInterrupted).toHaveLength(1);
      expect(localInterrupted[0]?.runId).toBe(run.id);
      expect(localInterrupted[0]?.kind).toBe("implementation");
      // Never failed: the run is exactly as it was (still queued, since the
      // worker never got as far as reporting "running").
      expect(store.get(run.id)?.status).toBe("queued");
    } finally {
      await fastRegistry.stop();
    }
  });

  // --- replay watermark ---------------------------------------------------

  it("drops a replayed run-event whose seq was already applied, and applies a newer one", async () => {
    const socket = await connect();
    const run = await queueRun();
    dispatch(run);
    await flush();
    const lease = socket.last("dispatch")!.lease;

    const eventFrame = (seq: number) => ({
      type: "run-event" as const,
      leaseId: lease.id,
      runId: run.id,
      event: {
        runId: run.id,
        ts: "2026-08-11T10:00:00.000Z",
        type: "log" as const,
        stream: "system" as const,
        text: `seq ${seq}`,
      },
      seq,
    });

    socket.receive(eventFrame(1));
    await flush();
    expect((await store.readEvents(run.id)).filter((event) => event.type === "log")).toHaveLength(1);

    // A replay of the same seq is dropped silently: no duplicate log line.
    socket.receive(eventFrame(1));
    await flush();
    expect((await store.readEvents(run.id)).filter((event) => event.type === "log")).toHaveLength(1);

    // A newer seq is applied.
    socket.receive(eventFrame(2));
    await flush();
    expect((await store.readEvents(run.id)).filter((event) => event.type === "log")).toHaveLength(2);
  });

  it("holds the watermark back until the frame's write has actually landed", async () => {
    const socket = await connect();
    const run = await queueRun();
    dispatch(run);
    await flush();
    const lease = socket.last("dispatch")!.lease;

    socket.receive({
      type: "run-event",
      leaseId: lease.id,
      runId: run.id,
      event: { runId: run.id, ts: "2026-08-11T10:00:00.000Z", type: "log", stream: "system", text: "in flight" },
      seq: 1,
    });

    // Nothing awaited in between, so the write is still queued. Telling the
    // worker "applied through 1" now would make it drop the frame from its
    // replay buffer while the host has yet to write it.
    socket.receive({ type: "heartbeat", ts: new Date().toISOString(), leaseIds: [lease.id] });
    expect(socket.last("lease-ack")?.seq).toBe(0);

    await flush();
    socket.receive({ type: "heartbeat", ts: new Date().toISOString(), leaseIds: [lease.id] });
    expect(socket.last("lease-ack")?.seq).toBe(1);
  });

  it("never acknowledges past a gap, and releases everything behind it once the gap is filled", async () => {
    const socket = await connect();
    const run = await queueRun();
    dispatch(run);
    await flush();
    const lease = socket.last("dispatch")!.lease;

    const eventFrame = (seq: number) => ({
      type: "run-event" as const,
      leaseId: lease.id,
      runId: run.id,
      event: {
        runId: run.id,
        ts: "2026-08-11T10:00:00.000Z",
        type: "log" as const,
        stream: "system" as const,
        text: `seq ${seq}`,
      },
      seq,
    });

    // Frames 2 and 3 arrive and land, but 1 never showed up. The watermark is
    // the contiguous prefix, so it stays at 0: acking 3 here would tell the
    // worker to drop a frame the host has never seen.
    socket.receive(eventFrame(2));
    socket.receive(eventFrame(3));
    await flush();
    socket.receive({ type: "heartbeat", ts: new Date().toISOString(), leaseIds: [lease.id] });
    expect(socket.last("lease-ack")?.seq).toBe(0);

    // The missing frame arrives; the whole run of them is contiguous now, so
    // the watermark jumps straight to 3 rather than one step at a time.
    socket.receive(eventFrame(1));
    await flush();
    socket.receive({ type: "heartbeat", ts: new Date().toISOString(), leaseIds: [lease.id] });
    expect(socket.last("lease-ack")?.seq).toBe(3);
    expect((await store.readEvents(run.id)).filter((event) => event.type === "log")).toHaveLength(3);
  });

  it("stalls the watermark on a failed write, then re-admits the resend and catches up", async () => {
    const socket = await connect();
    const run = await queueRun();
    dispatch(run);
    await flush();
    const lease = socket.last("dispatch")!.lease;

    // A directory where the artifact's bytes want to be: writeFile fails with
    // EISDIR, which is the "the write did not land" case without having to
    // reach for the real ones (a full disk, bad permissions).
    await mkdir(join(store.artifactsDir(run.id), "demo.png"), { recursive: true });

    socket.receive({
      type: "run-artifact",
      leaseId: lease.id,
      runId: run.id,
      artifact: { name: "demo.png", type: "screenshot", size: 3 },
      data: Buffer.from("png").toString("base64"),
      seq: 1,
    });
    socket.receive({
      type: "run-event",
      leaseId: lease.id,
      runId: run.id,
      event: { runId: run.id, ts: "2026-08-11T10:00:00.000Z", type: "log", stream: "system", text: "after the failure" },
      seq: 2,
    });
    await flush();

    // Frame 2 landed, but the watermark must not step over frame 1, which did
    // not: acking 2 would tell the worker to drop the artifact it still owes
    // the host. So the ack stays where it was, and keeps saying so on every
    // heartbeat, which is the signal the worker resends on.
    expect((await store.readEvents(run.id)).filter((event) => event.type === "log")).toHaveLength(1);
    socket.receive({ type: "heartbeat", ts: new Date().toISOString(), leaseIds: [lease.id] });
    expect(socket.last("lease-ack")?.seq).toBe(0);
    socket.receive({ type: "heartbeat", ts: new Date().toISOString(), leaseIds: [lease.id] });
    expect(socket.last("lease-ack")?.seq).toBe(0);

    // The worker resends the gap on the same healthy socket. It has to be
    // admitted again rather than dismissed as already seen, which is what
    // stops the lost artifact being lost for good.
    await rm(join(store.artifactsDir(run.id), "demo.png"), { recursive: true, force: true });
    socket.receive({
      type: "run-artifact",
      leaseId: lease.id,
      runId: run.id,
      artifact: { name: "demo.png", type: "screenshot", size: 3 },
      data: Buffer.from("png").toString("base64"),
      seq: 1,
    });
    await flush();

    // Filling the gap releases frame 2 with it: the watermark goes straight
    // to 2, and the artifact is on disk this time.
    socket.receive({ type: "heartbeat", ts: new Date().toISOString(), leaseIds: [lease.id] });
    expect(socket.last("lease-ack")?.seq).toBe(2);
    expect(await Bun.file(join(store.artifactsDir(run.id), "demo.png")).text()).toBe("png");
    // Frame 2 was applied once, not twice: the resend only covered the gap.
    expect((await store.readEvents(run.id)).filter((event) => event.type === "log")).toHaveLength(1);
  });

  it("does not settle or acknowledge a lease whose completion could not be applied", async () => {
    const socket = await connect();
    const run = await queueRun();
    dispatch(run);
    await flush();
    const lease = socket.last("dispatch")!.lease;

    // setStatus has to fail for the completion to fail. A directory where the
    // run's own record belongs makes its write throw with EISDIR, without
    // reaching into the store's private state to stub anything.
    const record = join(dir, "runs", run.id, "run.json");
    await rm(record, { force: true });
    await mkdir(record, { recursive: true });

    const completion = {
      type: "run-complete" as const,
      leaseId: lease.id,
      runId: run.id,
      outcome: "completed" as const,
      finishedAt: "2026-08-11T10:30:00.000Z",
      artifacts: [],
      attempts: [],
      costs: [],
      seq: 1,
    };
    socket.receive(completion);
    await flush();

    // The host never claimed it: no ack, the lease is still outstanding, and
    // the scheduler was not told the run settled.
    expect(socket.ofType("run-complete-ack")).toHaveLength(0);
    expect(registry.inFlight()).toBe(1);
    expect(settled).toEqual([]);

    // The worker still holds the completion in its replay buffer, so it
    // resends it on its next connection. With the run's record writable again
    // that replay applies, which is the recovery: the lease was never
    // acknowledged, so nothing was lost.
    await rm(record, { recursive: true, force: true });
    const reconnected = await reconnect([{ id: lease.id, runId: run.id, issuedAt: lease.issuedAt }]);
    reconnected.receive(completion);
    await flush();
    expect(reconnected.ofType("run-complete-ack")).toHaveLength(1);
    expect(store.get(run.id)?.status).toBe("completed");
    expect(settled).toEqual([run.id]);
  });

  it("sends a lease-ack per claimed lease on register (even at watermark 0) and on heartbeat", async () => {
    const socket = await connect();
    const run = await queueRun();
    dispatch(run);
    await flush();
    const lease = socket.last("dispatch")!.lease;

    // Reconnecting before anything has been reported: the ack still carries seq 0.
    const reconnected = await reconnect([{ id: lease.id, runId: run.id, issuedAt: lease.issuedAt }]);
    expect(reconnected.last("lease-ack")).toMatchObject({ type: "lease-ack", leaseId: lease.id, runId: run.id, seq: 0 });
    // Every ack restates the deadline, which is what the worker fences itself with.
    expect(Date.parse(reconnected.last("lease-ack")!.expiresAt)).toBeGreaterThan(Date.now());

    reconnected.receive({
      type: "run-event",
      leaseId: lease.id,
      runId: run.id,
      event: { runId: run.id, ts: "2026-08-11T10:00:00.000Z", type: "log", stream: "system", text: "hi" },
      seq: 1,
    });
    await flush();

    reconnected.receive({ type: "heartbeat", ts: new Date().toISOString(), leaseIds: [lease.id] });
    expect(reconnected.last("lease-ack")).toMatchObject({ type: "lease-ack", leaseId: lease.id, runId: run.id, seq: 1 });
  });

  it("holds a completion behind a gap, then applies it when a resend closes the gap", async () => {
    const socket = await connect();
    const run = await queueRun();
    dispatch(run);
    await flush();
    const lease = socket.last("dispatch")!.lease;

    // Frame 1's write fails, so the watermark cannot reach the completion at
    // frame 2. Acking that completion would tell the worker to throw away its
    // whole buffer for the lease, taking the only copy of frame 1 with it.
    await mkdir(join(store.artifactsDir(run.id), "demo.png"), { recursive: true });
    socket.receive({
      type: "run-artifact",
      leaseId: lease.id,
      runId: run.id,
      artifact: { name: "demo.png", type: "screenshot", size: 3 },
      data: Buffer.from("png").toString("base64"),
      seq: 1,
    });
    const completion = {
      type: "run-complete" as const,
      leaseId: lease.id,
      runId: run.id,
      outcome: "completed" as const,
      finishedAt: "2026-08-11T10:30:00.000Z",
      artifacts: [{ name: "demo.png", type: "screenshot" as const, size: 3 }],
      attempts: [],
      costs: [],
      seq: 2,
    };
    socket.receive(completion);
    await flush();

    // Nothing was written, acked or settled: the run is honestly unfinished
    // and the lease is still outstanding while the host chases frame 1.
    expect(store.get(run.id)?.status).not.toBe("completed");
    expect(socket.ofType("run-complete-ack")).toHaveLength(0);
    expect(registry.inFlight()).toBe(1);
    expect(settled).toEqual([]);

    // The worker resends frame 1, it lands, and the completion parked behind
    // it goes through on its own.
    await rm(join(store.artifactsDir(run.id), "demo.png"), { recursive: true, force: true });
    socket.receive({
      type: "run-artifact",
      leaseId: lease.id,
      runId: run.id,
      artifact: { name: "demo.png", type: "screenshot", size: 3 },
      data: Buffer.from("png").toString("base64"),
      seq: 1,
    });
    await flush();

    expect(store.get(run.id)?.status).toBe("completed");
    expect(socket.ofType("run-complete-ack")).toHaveLength(1);
    expect(registry.inFlight()).toBe(0);
    expect(settled).toEqual([run.id]);
    // The artifact really is there, so its manifest entry is not reported lost.
    const logs = (await store.readEvents(run.id)).filter((event) => event.type === "log").map((event) => event.text);
    expect(logs.some((text) => text.includes("did not reach the host"))).toBe(false);
  });

  it("steps over frames the worker says it dropped, and releases a completion held behind them", async () => {
    const socket = await connect();
    const run = await queueRun();
    dispatch(run);
    await flush();
    const lease = socket.last("dispatch")!.lease;

    // The worker's buffer overflowed while this host was unreachable: frames
    // 1 and 2 are gone for good, so the watermark would otherwise never reach
    // the completion at 3 and the run would hang forever.
    socket.receive({
      type: "run-complete",
      leaseId: lease.id,
      runId: run.id,
      outcome: "completed",
      finishedAt: "2026-08-11T10:30:00.000Z",
      artifacts: [],
      attempts: [],
      costs: [],
      seq: 3,
    });
    await flush();
    expect(store.get(run.id)?.status).not.toBe("completed");

    socket.receive({ type: "lease-gap", leaseId: lease.id, runId: run.id, throughSeq: 2, dropped: 2 });
    await flush();

    expect(store.get(run.id)?.status).toBe("completed");
    expect(socket.ofType("run-complete-ack")).toHaveLength(1);
    // The loss is recorded against the run rather than swallowed.
    const logs = (await store.readEvents(run.id)).filter((event) => event.type === "log").map((event) => event.text);
    expect(logs.some((text) => text.includes("2 log or artifact frame(s) were dropped"))).toBe(true);
  });

  it("tells a worker that reconnects claiming a lease this host no longer holds to abort it", async () => {
    const socket = await connect();
    const run = await queueRun();
    dispatch(run);
    await flush();
    const lease = socket.last("dispatch")!.lease;

    // The worker was partitioned long enough for its lease to expire; the run
    // has been handed back to the scheduler and may already be running
    // elsewhere. It comes back still claiming a lease the host has forgotten.
    socket.drop();
    const orphaned = await reconnect([{ id: "lease-gone", runId: run.id, issuedAt: lease.issuedAt }]);

    // Not merely dropped from the worker's claims: an explicit instruction to
    // stop, which is what keeps two workers off the same branch.
    const lost = orphaned.last("lease-lost");
    expect(lost).toMatchObject({ type: "lease-lost", leaseId: "lease-gone", runId: run.id });
    expect(lost?.reason).toContain("no longer yours");
  });

  it("only dispatches once the lease is on disk, so a restart cannot hand the run out twice", async () => {
    const socket = await connect();
    const run = await queueRun();

    // What the claim looked like on disk at the instant the worker was told
    // to start. A crash in that window is the whole risk: the next boot would
    // find no lease for a run somebody is already executing, and dispatch it
    // to a second worker.
    let leasedWhenDispatched: string[] | undefined;
    const send = socket.send.bind(socket);
    socket.send = (raw: string) => {
      send(raw);
      if ((JSON.parse(raw) as { type?: string }).type === "dispatch") {
        const onDisk: unknown = existsSync(leasesPath) ? JSON.parse(readFileSync(leasesPath, "utf8")) : [];
        leasedWhenDispatched = Array.isArray(onDisk) ? onDisk.map((entry: { runId?: string }) => entry.runId ?? "") : [];
      }
    };

    expect(dispatch(run)).toMatchObject({ placed: true });
    // The outcome is immediate (capacity is accounted for at once) but the
    // frame itself waits for the write.
    expect(socket.last("dispatch")).toBeUndefined();
    await flush();

    expect(socket.last("dispatch")?.run.id).toBe(run.id);
    expect(leasedWhenDispatched).toEqual([run.id]);
  });

  it("routes frames the worker sends the instant it is told `registered`", async () => {
    // The worker starts heartbeating and flushes whatever it queued while
    // disconnected as soon as `registered` lands, and the host is still
    // finishing the registration at that point (it drains and acks each
    // lease afterwards). Reacting to the frame the way a real worker does is
    // the only way to catch a registration that admits traffic too late.
    const { token } = fleet.mintPairingToken();
    const socket = new FakeSocket();
    const send = socket.send.bind(socket);
    socket.send = (raw: string) => {
      send(raw);
      if ((JSON.parse(raw) as { type?: string }).type === "registered") {
        socket.receive({ type: "heartbeat", ts: new Date().toISOString(), leaseIds: [] });
      }
    };
    registry.accept(socket.asWebSocket(), "127.0.0.1");
    socket.receive({
      type: "register",
      protocolVersion: WORKER_PROTOCOL_VERSION,
      auth: { kind: "pairing", token },
      name: "eager-1",
      capabilities: capabilities(),
      activeLeases: [],
    });
    await flush();

    // Dropped instead of routed, the heartbeat gets no answer at all.
    expect(socket.ofType("heartbeat-ack")).toHaveLength(1);
  });

  // --- restart recovery ----------------------------------------------------

  it("restore() re-adopts a persisted lease so a reconnecting worker keeps reporting on it, and drops one whose run already finished", async () => {
    // Enrolled on the shared FleetStore, so the restored registry (which is
    // handed the same store) recognises the credential this worker comes back
    // with, exactly as a fresh process would.
    const worker = await enroll("bench-restart");
    const active = await queueRun();
    const finished = await queueRun();
    await store.setStatus(finished.id, "completed", { finishedAt: new Date().toISOString() });

    const seedLeases = new LeaseStore(leasesPath);
    await seedLeases.init();
    seedLeases.put({
      id: "lease-active",
      runId: active.id,
      workerId: worker.id,
      workerName: worker.name,
      kind: "implementation",
      issuedAt: "2026-08-11T09:00:00.000Z",
      expiresAt: "2026-08-11T09:10:00.000Z",
      appliedSeq: 3,
    });
    seedLeases.put({
      id: "lease-finished",
      runId: finished.id,
      workerId: worker.id,
      workerName: worker.name,
      kind: "implementation",
      issuedAt: "2026-08-11T09:00:00.000Z",
      expiresAt: "2026-08-11T09:10:00.000Z",
      appliedSeq: 0,
    });
    await seedLeases.flush();

    const restoredRegistry = new WorkerRegistry({
      config,
      store,
      memories,
      fleet,
      leases: new LeaseStore(leasesPath),
      onRunSettled: () => {},
      onRunRejected: () => {},
      onRunInterrupted: () => {},
    });
    try {
      const restored = await restoredRegistry.restore();
      expect(restored).toEqual([
        {
          leaseId: "lease-active",
          runId: active.id,
          workerId: worker.id,
          workerName: worker.name,
          kind: "implementation",
        },
      ]);

      // The still-open lease is live in the registry (a cancel against it is
      // "pending", not "unknown"), while the finished one was dropped.
      expect(restoredRegistry.cancel(active.id)).toBe("pending");
      expect(restoredRegistry.cancel(finished.id)).toBe("unknown");

      // A worker that reconnects claiming the restored lease resumes
      // reporting on it rather than being told it's unknown.
      const socket = new FakeSocket();
      restoredRegistry.accept(socket.asWebSocket(), "127.0.0.1");
      socket.receive({
        type: "register",
        protocolVersion: WORKER_PROTOCOL_VERSION,
        auth: { kind: "credential", workerId: worker.id, secret: worker.credential },
        name: worker.name,
        capabilities: capabilities(),
        activeLeases: [{ id: "lease-active", runId: active.id, issuedAt: "2026-08-11T09:00:00.000Z" }],
      });
      await flush();
      expect(socket.last("lease-ack")).toMatchObject({ type: "lease-ack", leaseId: "lease-active", runId: active.id, seq: 3 });

      socket.receive({ type: "run-patch", leaseId: "lease-active", runId: active.id, patch: { status: "running" } });
      await flush();
      expect(store.get(active.id)?.status).toBe("running");
    } finally {
      await restoredRegistry.stop();
    }
  });
});
