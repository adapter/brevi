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
  type WorkerAuth,
} from "@brevi/shared";
import { CLOSED, FakeSocket, flush } from "./fake-socket.js";
import { FleetStore } from "../src/fleet.js";
import { MemoryStore } from "../src/memory.js";
import { RunStore } from "../src/state.js";
import { WorkerRegistry } from "../src/workers.js";

// What an operator actually does, driven through the registry that answers
// the worker channel: pair a machine, watch it come back on its own
// credential, rename/drain/revoke it, and restart the host without losing any
// of that. FleetStore's storage rules have their own unit tests in
// fleet.test.ts. Run with `bun test packages/orchestrator` from the repo root
// (after `bun run build`, so the @brevi/shared import resolves to its dist
// output).

const ticket: Ticket = {
  id: "ticket-1",
  identifier: "PD-54",
  title: "Fleet 2",
  description: "Worker enrollment and per-worker auth.",
  url: "https://linear.app/x/issue/PD-54",
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
    provider: "bwrap" as const,
        maxConcurrency,
    version: "0.5.0",
  };
}

interface Host {
  fleet: FleetStore;
  registry: WorkerRegistry;
}

let dir: string;
let fleetPath: string;
let store: RunStore;
let memories: MemoryStore;
let config: BreviConfig;
let host: Host;
/** Every registry a test stood up, so afterEach can close their sockets. */
let hosts: Host[];

/**
 * Stand up a host over `fleetPath`. `ttlMinutes` is only passed by the expiry
 * test (a negative TTL mints a token that is already dead, without waiting or
 * faking the clock); the restart test calls this a second time to prove a
 * fresh FleetStore over the same file revives the same fleet.
 */
async function startHost(ttlMinutes?: number): Promise<Host> {
  const fleet = ttlMinutes === undefined ? new FleetStore(fleetPath) : new FleetStore(fleetPath, ttlMinutes);
  await fleet.init();
  const registry = new WorkerRegistry({
    config,
    store,
    memories,
    fleet,
    onRunSettled: () => undefined,
    onRunRejected: () => undefined,
    onRunInterrupted: () => undefined,
  });
  const created = { fleet, registry };
  hosts.push(created);
  return created;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "brevi-enroll-"));
  fleetPath = join(dir, "fleet.json");
  store = new RunStore(join(dir, "runs"));
  await store.init();
  memories = new MemoryStore(join(dir, "memories"));
  await memories.init();
  config = configSchema.parse({ fleet: { reconnectGraceSeconds: 3600 } });
  hosts = [];
  host = await startHost();
});

afterEach(async () => {
  for (const entry of hosts) await entry.registry.stop();
  // Registration, heartbeats and dispatch all queue writes that no caller
  // awaits; draining them before the directory goes away keeps a late write
  // from failing against a path that no longer exists. `drain` covers the
  // run store too, so it subsumes the `store.flush()` this used to do.
  for (const entry of hosts) await entry.registry.drain();
  await rm(dir, { recursive: true, force: true });
});

/** Connect one worker with the given auth envelope and wait for the host's answer. */
async function register(auth: WorkerAuth, options: { name?: string; on?: Host } = {}): Promise<FakeSocket> {
  const socket = new FakeSocket();
  (options.on ?? host).registry.accept(socket.asWebSocket(), "127.0.0.1");
  socket.receive({
    type: "register",
    protocolVersion: WORKER_PROTOCOL_VERSION,
    auth,
    name: options.name ?? "bench-1",
    capabilities: capabilities(),
    activeLeases: [],
  });
  await flush();
  return socket;
}

/** Pair a fresh machine and return its socket plus what enrollment handed it. */
async function enroll(name = "bench-1"): Promise<{ socket: FakeSocket; workerId: string; credential: string }> {
  const { token } = host.fleet.mintPairingToken();
  const socket = await register({ kind: "pairing", token }, { name });
  const registered = socket.last("registered");
  expect(registered).toBeDefined();
  expect(registered?.credential).toStartWith("bwc_");
  return { socket, workerId: registered?.workerId ?? "", credential: registered?.credential ?? "" };
}

function dispatch(run: Run) {
  return host.registry.dispatch({
    kind: "implementation",
    run,
    repoKey: "brevi",
    repo,
    config,
    prompts: { prDescription: "concise", memories: [], recordMemories: false },
  });
}

describe("worker enrollment", () => {
  it("redeems a pairing token exactly once", async () => {
    const { token } = host.fleet.mintPairingToken();
    const first = await register({ kind: "pairing", token }, { name: "bench-1" });
    expect(first.last("registered")?.name).toBe("bench-1");
    expect(first.last("registered")?.state).toBe("active");

    // A second machine running the same copied command must not get in: the
    // token died the moment it was redeemed.
    const second = await register({ kind: "pairing", token }, { name: "impostor" });
    expect(second.last("rejected")?.code).toBe("invalid-token");
    expect(second.last("registered")).toBeUndefined();

    const workers = host.registry.list();
    expect(workers).toHaveLength(1);
    expect(workers[0]?.connection).toBe("online");
    expect(workers[0]?.name).toBe("bench-1");
    expect(workers[0]?.capabilities?.provider).toBe("bwrap");
    expect(workers[0]?.address).toBe("127.0.0.1");
  });

  it("refuses a pairing token past its expiry", async () => {
    const expired = await startHost(-1);
    const { token } = expired.fleet.mintPairingToken();
    const socket = await register({ kind: "pairing", token }, { on: expired });

    expect(socket.last("rejected")?.code).toBe("expired-token");
    expect(expired.registry.list()).toHaveLength(0);
  });

  it("authenticates a returning worker on its stored credential alone", async () => {
    const { socket, workerId, credential } = await enroll();
    socket.drop();
    await flush();
    expect(host.registry.list()[0]?.connection).toBe("offline");

    const again = await register({ kind: "credential", workerId, secret: credential });
    const registered = again.last("registered");
    expect(registered?.workerId).toBe(workerId);
    // No second credential: the worker already holds one, and no second
    // enrollment was created for the same machine either.
    expect(registered?.credential).toBeUndefined();
    expect(host.registry.list()).toHaveLength(1);
    expect(host.registry.list()[0]?.connection).toBe("online");

    // A credential that was never minted authenticates nothing.
    const impostor = await register({ kind: "credential", workerId, secret: "bwc_not-the-secret" });
    expect(impostor.last("rejected")?.code).toBe("unauthorized");
    expect(host.registry.list()).toHaveLength(1);
  });

  it("disconnects a revoked worker and refuses the credential it kept", async () => {
    const { socket, workerId, credential } = await enroll();
    const running = await store.createRun(ticket);
    expect(dispatch(running)).toMatchObject({ placed: true });

    expect(await host.registry.revoke(workerId)).toBe(true);
    expect(socket.last("revoked")).toBeDefined();
    expect(socket.readyState).toBe(CLOSED);
    expect(host.registry.list()).toHaveLength(0);
    // Its run is treated exactly as a disconnect's would be: the lease is
    // held through the reconnect grace window (which this worker can never
    // use) rather than failed on the spot by the revoke itself.
    await flush();
    expect(host.registry.inFlight()).toBe(1);
    expect(store.get(running.id)?.status).toBe("queued");

    // Coming back with what it still holds is refused, so a revoked machine
    // has nothing left to retry with.
    const retry = await register({ kind: "credential", workerId, secret: credential });
    expect(retry.last("rejected")?.code).toBe("unauthorized");
    expect(host.registry.list()).toHaveLength(0);

    // And a revoke of an id that is gone reports that, rather than pretending.
    expect(await host.registry.revoke(workerId)).toBe(false);
  });

  it("renames an enrolled worker without disturbing its connection", async () => {
    const { workerId } = await enroll();
    expect(await host.registry.rename(workerId, "bench-renamed")).toBe(true);
    expect(host.registry.list()[0]?.name).toBe("bench-renamed");
    expect(host.registry.list()[0]?.connection).toBe("online");
    expect(await host.registry.rename("wk-doesnotexist", "nope")).toBe(false);
  });

  it("stops dispatching to a drained worker but leaves its in-flight run alone", async () => {
    const { socket, workerId } = await enroll();
    const running = await store.createRun(ticket);
    expect(dispatch(running)).toMatchObject({ placed: true });
    // The dispatch frame trails the lease's write to disk, so it takes a turn.
    await flush();
    const lease = socket.last("dispatch")?.lease;
    expect(lease).toBeDefined();

    expect(await host.registry.setState(workerId, "draining")).toBe(true);
    // The worker learns immediately rather than at its next heartbeat.
    expect(socket.last("worker-state")?.state).toBe("draining");
    expect(host.registry.list()[0]?.state).toBe("draining");

    // No new work: the only worker there is has been taken out of rotation,
    // even though it still has a free slot.
    expect(host.registry.capacity()).toBe(0);
    const queued = await store.createRun(ticket);
    expect(dispatch(queued)).toMatchObject({ placed: false });
    expect(socket.ofType("dispatch")).toHaveLength(1);

    // What it already holds is untouched, and still reports normally.
    expect(host.registry.list()[0]?.activeRuns).toBe(1);
    socket.receive({
      type: "run-complete",
      leaseId: lease?.id ?? "",
      runId: running.id,
      outcome: "completed",
      finishedAt: "2026-08-11T10:30:00.000Z",
      artifacts: [],
      attempts: [],
      costs: [],
    });
    await flush();
    expect(store.get(running.id)?.status).toBe("completed");

    // Enabling it puts it straight back in rotation.
    expect(await host.registry.setState(workerId, "active")).toBe(true);
    expect(socket.last("worker-state")?.state).toBe("active");
    expect(host.registry.capacity()).toBe(2);
    expect(dispatch(queued)).toMatchObject({ placed: true });
  });

  it("keeps the enrolled fleet across a host restart", async () => {
    const { socket, workerId, credential } = await enroll("bench-1");
    expect(await host.registry.rename(workerId, "bench-renamed")).toBe(true);
    expect(await host.registry.setState(workerId, "draining")).toBe(true);
    socket.drop();
    await flush();

    // A brand new FleetStore over the same file, the way a restarted host
    // comes up: the enrollment, its name and its state all survive.
    host = await startHost();
    const revived = host.registry.list();
    expect(revived).toHaveLength(1);
    expect(revived[0]?.id).toBe(workerId);
    expect(revived[0]?.name).toBe("bench-renamed");
    expect(revived[0]?.state).toBe("draining");
    expect(revived[0]?.connection).toBe("offline");
    // Capabilities are remembered from the last connection, so the Workers
    // page can still say what the machine is while it is offline.
    expect(revived[0]?.capabilities?.provider).toBe("bwrap");

    // And the credential it kept still authenticates against the reloaded
    // fleet: a restart must not cost the fleet its enrollments.
    const reconnected = await register({ kind: "credential", workerId, secret: credential });
    expect(reconnected.last("registered")?.workerId).toBe(workerId);
    expect(reconnected.last("registered")?.state).toBe("draining");
    expect(host.registry.list()[0]?.connection).toBe("online");
  });
});

describe("local worker", () => {
  it("enrolls with no pairing ceremony, is marked local, and connects on the minted credential", async () => {
    const { workerId, credential } = await host.registry.ensureLocalWorker("this-machine");
    // Minting alone (before anything ever connects as it) already tells the
    // dashboard about it, the same "workers" emit every other mutation uses.
    expect(host.registry.list()).toHaveLength(1);
    expect(host.registry.list()[0]).toMatchObject({ id: workerId, local: true, connection: "offline" });

    const socket = await register({ kind: "credential", workerId, secret: credential });
    expect(socket.last("registered")?.workerId).toBe(workerId);
    expect(host.registry.list()[0]?.connection).toBe("online");
    expect(host.registry.list()[0]?.local).toBe(true);
  });

  it("rotates the credential on every call: the old plaintext stops authenticating, the new one works", async () => {
    const first = await host.registry.ensureLocalWorker("this-machine");
    expect(host.fleet.authenticate(first.workerId, first.credential)?.id).toBe(first.workerId);

    const second = await host.registry.ensureLocalWorker("this-machine");
    expect(second.workerId).toBe(first.workerId);
    expect(second.credential).not.toBe(first.credential);
    expect(host.fleet.authenticate(first.workerId, first.credential)).toBeNull();
    expect(host.fleet.authenticate(second.workerId, second.credential)?.id).toBe(first.workerId);

    // The credential a socket now connects with must be the newest one.
    const stale = await register({ kind: "credential", workerId: first.workerId, secret: first.credential });
    expect(stale.last("rejected")?.code).toBe("unauthorized");
    const fresh = await register({ kind: "credential", workerId: first.workerId, secret: second.credential });
    expect(fresh.last("registered")?.workerId).toBe(first.workerId);
  });

  it("keeps a drained local worker drained across ensureLocalWorker calls", async () => {
    const { workerId } = await host.registry.ensureLocalWorker("this-machine");
    expect(await host.registry.setState(workerId, "draining")).toBe(true);

    await host.registry.ensureLocalWorker("this-machine");
    expect(host.registry.list()[0]?.state).toBe("draining");
  });

  it("refuses to revoke or rename the local worker, and its record survives untouched", async () => {
    const { workerId } = await host.registry.ensureLocalWorker("this-machine");

    await expect(host.registry.revoke(workerId)).rejects.toThrow(/cannot be revoked/);
    await expect(host.registry.rename(workerId, "renamed")).rejects.toThrow(/cannot be renamed/);

    const workers = host.registry.list();
    expect(workers).toHaveLength(1);
    expect(workers[0]?.id).toBe(workerId);
    expect(workers[0]?.name).toBe("this-machine");
    expect(workers[0]?.local).toBe(true);
  });
});
