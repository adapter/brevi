import { afterEach, describe, expect, test } from "bun:test";
import type { Run, RunStatus, Ticket } from "@brevi/shared";
import { WebSocket, WebSocketServer } from "ws";
import { FleetMonitor, isFreshCompletion, type FleetState } from "../src/main/fleet.js";

// -- fixtures, same shape as summary.test.ts's --------------------------

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

function helloMessage(runs: Run[]): string {
  return JSON.stringify({
    type: "hello",
    runs,
    tickets: [],
    config: {},
    linearStatus: { state: "connected" },
  });
}

function runUpdatedMessage(updated: Run): string {
  return JSON.stringify({ type: "run-updated", run: updated });
}

// -- a real ws server on an ephemeral port --------------------------------

const openServers = new Set<WebSocketServer>();

function bindServer(port: number): Promise<WebSocketServer> {
  return new Promise((resolve, reject) => {
    const server = new WebSocketServer({ port });
    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
}

/**
 * Starts a tracked ws server on `port` (0 for an ephemeral one), retrying a
 * couple of times on EADDRINUSE: a restart test rebinds the same port right
 * after closing the previous server, and the OS occasionally needs another
 * moment to let it go.
 */
async function startServer(port = 0): Promise<{ server: WebSocketServer; port: number }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const server = await bindServer(port);
      openServers.add(server);
      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : port;
      return { server, port: boundPort };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE" || attempt >= 10) throw err;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

/** Resolves with the next client the server accepts: used both to get a socket to send on, and to detect a reconnect happened. */
function nextConnection(server: WebSocketServer): Promise<WebSocket> {
  return new Promise((resolve) => server.once("connection", (ws) => resolve(ws)));
}

/**
 * Terminates any connected clients and closes the server without waiting for
 * its "close" event: under Bun, an http.Server whose only connections were
 * websocket upgrades that got `.terminate()`d never reliably emits "close",
 * even though the listening socket is released right away. Not awaiting it
 * is safe here since `startServer`'s retry loop covers the rare case the
 * port isn't free yet on the very next bind.
 */
function stopServer(server: WebSocketServer): void {
  for (const client of server.clients) client.terminate();
  server.close();
  openServers.delete(server);
}

/** Kills the current connection and server, then restarts a server on the same port, mirroring an orchestrator restart. */
async function restartServer(server: WebSocketServer, port: number): Promise<{ server: WebSocketServer; port: number }> {
  stopServer(server);
  return startServer(port);
}

afterEach(() => {
  for (const server of openServers) stopServer(server);
  openServers.clear();
});

// -- monitor harness --------------------------------------------------------

/**
 * Wraps a FleetMonitor with promise-based waiters instead of sleeps.
 *
 * `waitForConnected` and `waitForNextChange` are meant to be used together,
 * in order, around each `client.send(...)` (see `sendAndSync`):
 *   1. await waitForConnected()   // the client-side socket finished its
 *                                  // handshake, so onChange(connected:true)
 *                                  // (if any) already fired
 *   2. const changed = waitForNextChange()  // register before sending
 *   3. client.send(...)
 *   4. await changed               // resolves on the onChange this exact
 *                                  // message produces
 * That ordering is what makes step 4 deterministic: nothing else causes an
 * onChange between steps 2 and 4, so the "next" one has to be this message's.
 */
function createHarness(url: string) {
  const notified: Run[] = [];
  let connectedWaiters: Array<() => void> = [];
  let changeWaiters: Array<(state: FleetState) => void> = [];

  const monitor = new FleetMonitor({
    url,
    onChange: (state) => {
      if (state.connected) {
        for (const resolve of connectedWaiters) resolve();
        connectedWaiters = [];
      }
      for (const resolve of changeWaiters) resolve(state);
      changeWaiters = [];
    },
    onRunFinished: (finishedRun) => {
      notified.push(finishedRun);
    },
  });

  function waitForConnected(timeoutMs = 8000): Promise<void> {
    if (monitor.state.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting to connect")), timeoutMs);
      connectedWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  function waitForNextChange(timeoutMs = 8000): Promise<FleetState> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a fleet update")), timeoutMs);
      changeWaiters.push((state) => {
        clearTimeout(timer);
        resolve(state);
      });
    });
  }

  return { monitor, notified, waitForConnected, waitForNextChange };
}

type Harness = ReturnType<typeof createHarness>;
const openHarnesses = new Set<Harness>();

afterEach(() => {
  for (const harness of openHarnesses) harness.monitor.stop();
  openHarnesses.clear();
});

function trackHarness(harness: Harness): Harness {
  openHarnesses.add(harness);
  return harness;
}

/**
 * Waits for a client to connect (call once per connection: initial connect,
 * or after a restart) and confirms the client-side socket is open.
 */
async function connectClient(server: WebSocketServer, harness: Harness): Promise<WebSocket> {
  const client = await nextConnection(server);
  await harness.waitForConnected();
  return client;
}

/** Sends `payload` on an already-connected client and waits for the state update it produces. */
async function send(harness: Harness, client: WebSocket, payload: string): Promise<FleetState> {
  const changed = harness.waitForNextChange();
  client.send(payload);
  return changed;
}

// -- pure helper ----------------------------------------------------------

describe("isFreshCompletion", () => {
  test("true for an active status landing on completed", () => {
    expect(isFreshCompletion("running", "completed")).toBe(true);
  });

  test("true for an active status landing on failed", () => {
    expect(isFreshCompletion("queued", "failed")).toBe(true);
  });

  test("false when there's no prior observation", () => {
    expect(isFreshCompletion(undefined, "failed")).toBe(false);
  });

  test("false when the prior status was already terminal", () => {
    expect(isFreshCompletion("failed", "failed")).toBe(false);
    expect(isFreshCompletion("completed", "failed")).toBe(false);
  });

  test("false when the new status isn't terminal", () => {
    expect(isFreshCompletion("queued", "running")).toBe(false);
  });
});

// -- socket-level behaviour -------------------------------------------------

describe("FleetMonitor", () => {
  test("fresh launch: a first hello with already-terminal runs notifies for nothing", async () => {
    const { server, port } = await startServer();
    const harness = trackHarness(createHarness(`http://127.0.0.1:${port}`));
    harness.monitor.start();
    const client = await connectClient(server, harness);

    const state = await send(
      harness,
      client,
      helloMessage([run("done", "completed"), run("dead", "failed")]),
    );

    expect(state.runs.map((r) => r.status).sort()).toEqual(["completed", "failed"]);
    expect(harness.notified).toEqual([]);
  });

  test("crash recovery: reconnect hello reports an interrupted run as failed, exactly once", async () => {
    let { server, port } = await startServer();
    const harness = trackHarness(createHarness(`http://127.0.0.1:${port}`));
    harness.monitor.start();
    let client = await connectClient(server, harness);

    await send(harness, client, helloMessage([run("r1", "running")]));
    expect(harness.notified).toEqual([]);

    // The orchestrator process dies and restarts on the same port, having
    // marked the interrupted run failed before the desktop ever reconnects.
    ({ server, port } = await restartServer(server, port));
    client = await connectClient(server, harness);

    const state = await send(harness, client, helloMessage([run("r1", "failed")]));

    expect(state.runs.find((r) => r.id === "r1")?.status).toBe("failed");
    expect(harness.notified.map((r) => r.id)).toEqual(["r1"]);
    expect(harness.notified[0]?.status).toBe("failed");
  }, 15000);

  test("transient disconnect: reconnect hello reports the run completed, exactly once, and a repeat doesn't notify again", async () => {
    let { server, port } = await startServer();
    const harness = trackHarness(createHarness(`http://127.0.0.1:${port}`));
    harness.monitor.start();
    let client = await connectClient(server, harness);

    await send(harness, client, helloMessage([run("r2", "running")]));

    ({ server, port } = await restartServer(server, port));
    client = await connectClient(server, harness);
    await send(harness, client, helloMessage([run("r2", "completed")]));

    expect(harness.notified.map((r) => r.id)).toEqual(["r2"]);
    expect(harness.notified[0]?.status).toBe("completed");

    // A further reconnect hello repeating the same terminal status must not
    // notify again.
    ({ server, port } = await restartServer(server, port));
    client = await connectClient(server, harness);
    await send(harness, client, helloMessage([run("r2", "completed")]));

    expect(harness.notified).toHaveLength(1);
  }, 15000);

  test("runs unknown at reconnect (created and finished entirely while disconnected) don't notify", async () => {
    let { server, port } = await startServer();
    const harness = trackHarness(createHarness(`http://127.0.0.1:${port}`));
    harness.monitor.start();
    let client = await connectClient(server, harness);

    await send(harness, client, helloMessage([])); // nothing known yet

    ({ server, port } = await restartServer(server, port));
    client = await connectClient(server, harness);
    const state = await send(harness, client, helloMessage([run("brand-new", "completed")]));

    expect(state.runs.map((r) => r.id)).toEqual(["brand-new"]);
    expect(harness.notified).toEqual([]);
  }, 15000);

  test("a live run-updated still notifies once, and a later hello repeating it doesn't notify again", async () => {
    const { server, port } = await startServer();
    const harness = trackHarness(createHarness(`http://127.0.0.1:${port}`));
    harness.monitor.start();
    const client = await connectClient(server, harness);

    await send(harness, client, helloMessage([run("r3", "running")]));

    await send(harness, client, runUpdatedMessage(run("r3", "completed")));
    expect(harness.notified.map((r) => r.id)).toEqual(["r3"]);

    await send(harness, client, helloMessage([run("r3", "completed")]));
    expect(harness.notified).toHaveLength(1);
  });

  test("setUrl moves the connection, and the new endpoint's first hello notifies for nothing", async () => {
    const first = await startServer();
    const harness = trackHarness(createHarness(`http://127.0.0.1:${first.port}`));
    harness.monitor.start();
    const firstClient = await connectClient(first.server, harness);

    await send(harness, firstClient, helloMessage([run("old", "running")]));

    // server.port changed and the orchestrator restarted on a new address.
    const second = await startServer();
    harness.monitor.setUrl(`http://127.0.0.1:${second.port}`);
    const secondClient = await connectClient(second.server, harness);

    // The runs behind the new address are a first hello, not a reconnect
    // snapshot of the old one: treating them as a diff would report the run
    // left behind on the old endpoint as freshly finished.
    const state = await send(harness, secondClient, helloMessage([run("old", "failed")]));

    expect(state.runs.map((r) => r.id)).toEqual(["old"]);
    expect(harness.notified).toEqual([]);
  }, 15000);
});
