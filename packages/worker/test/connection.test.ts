import { describe, expect, it } from "bun:test";
import { WebSocket, WebSocketServer } from "ws";
import {
  configSchema,
  parseWorkerMessage,
  repoConfigSchema,
  WORKER_REPLAY_BUFFER_LIMIT,
  type HostMessage,
  type RegisterMessage,
  type WorkerCapabilities,
  type WorkerMessage,
} from "@brevi/shared";
import { connectToHost, type WorkerConnection } from "../src/connection.js";

// Run with `bun test packages/worker` from the repo root (after
// `bun run build`, so the @brevi/shared import resolves to its dist output).
// Not part of the tsc build: the package's tsconfig only includes src/.
//
// This drives the real connectToHost against a real in-process `ws`
// WebSocketServer standing in for the host: it's a small scripted fake, not
// a mock of connection.ts itself, so what's under test is the actual replay
// buffer, sequencing, and lease-ack handling connection.ts implements.

/** What the fake host enrolls every worker in this suite as; the id is the host's to assign. */
const WORKER_ID = "wk-test";
const CREDENTIAL = "bwc_test-credential";

const CAPABILITIES: WorkerCapabilities = {
  os: "linux",
  arch: "x64",
  provider: "bwrap",
  agentCommands: ["claude", "codex"],
  maxConcurrency: 4,
  version: "0.0.0-test",
};

interface FakeSession {
  socket: WebSocket;
  register: RegisterMessage;
}

interface FakeHost {
  url: string;
  /** Every session the host has accepted a `register` from, oldest first. */
  sessions: FakeSession[];
  /** Every non-register frame received across every session, in receipt order. */
  received: WorkerMessage[];
  /** Sends one host->worker frame down a given session's socket. */
  ack(session: FakeSession, message: HostMessage): void;
  /** Drops a session's socket without a clean handshake, as a network blip would. */
  drop(session: FakeSession): void;
  close(): Promise<void>;
}

/** Starts a fake host on an ephemeral loopback port. Auto-responds `registered` to every `register` it sees; everything else (lease-ack, run-complete-ack, ...) is scripted explicitly by the test via `ack`. */
async function startFakeHost(): Promise<FakeHost> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const address = wss.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const sessions: FakeSession[] = [];
  const received: WorkerMessage[] = [];

  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        return;
      }
      const message = parseWorkerMessage(parsed);
      if (!message) return;
      if (message.type === "register") {
        const session: FakeSession = { socket, register: message };
        sessions.push(session);
        const registered: HostMessage = {
          type: "registered",
          protocolVersion: message.protocolVersion,
          heartbeatIntervalMs: 15_000,
          hostVersion: "test",
          // The id and the name are the host's to assign, so this fake picks
          // them the way a real host does rather than echoing the worker.
          workerId: WORKER_ID,
          name: message.name,
          state: "active",
          // Only the connection that redeemed a pairing token is answered
          // with one; every session here presents the same token, so the
          // credential is handed out once and the worker stores it.
          ...(message.auth.kind === "pairing" ? { credential: CREDENTIAL } : {}),
        };
        socket.send(JSON.stringify(registered));
        return;
      }
      received.push(message);
    });
  });

  return {
    url: `http://127.0.0.1:${port}`,
    sessions,
    received,
    ack(session, message) {
      session.socket.send(JSON.stringify(message));
    },
    drop(session) {
      session.socket.close();
    },
    close() {
      // wss.close()'s own callback waits for the underlying http server's
      // 'close' event, which in practice does not reliably fire just from
      // terminating every client socket; forcing every socket closed and
      // resolving immediately keeps a test's cleanup from hanging on it.
      for (const session of sessions) session.socket.terminate();
      wss.close();
      return Promise.resolve();
    },
  };
}

/** Polls `predicate` instead of a fixed sleep, so a test only waits as long as the condition actually takes (bounded by timeoutMs) rather than a guessed-at delay. */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for condition after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Waits `ms` without asserting anything: only used to give a *negative* assertion (a frame must not have arrived yet) a bounded window to fail in, well under REPLAY_UNBLOCK_MS so the backstop can't be what's masking a bug. */
function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function patchFrame(leaseId: string, runId = "run-1"): WorkerMessage {
  return { type: "run-patch", leaseId, runId, patch: {} };
}

function eventFrame(leaseId: string, runId = "run-1", text = "line"): WorkerMessage {
  return {
    type: "run-event",
    leaseId,
    runId,
    event: { runId, ts: new Date().toISOString(), type: "log", stream: "system", text },
  };
}

function completeFrame(leaseId: string, runId = "run-1"): WorkerMessage {
  return { type: "run-complete", leaseId, runId, outcome: "completed", artifacts: [], attempts: [], costs: [] };
}

/** seq of a reporting frame; every frame this suite sends is one of the five reporting types, which always carry it once stamped. */
/** A lease-ack for the suite's one lease. `expiresAt` is always well in the future: the deadline fence is not what these exercise. */
function leaseAck(seq: number): HostMessage {
  return {
    type: "lease-ack",
    leaseId: "lease-a",
    runId: "run-1",
    seq,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
}

function seqOf(message: WorkerMessage): number | undefined {
  return "seq" in message ? message.seq : undefined;
}

/**
 * Enrolls against the fake host with a pairing token, the same way a machine
 * connecting for the first time does. `onEnrolled` is deliberately a no-op:
 * these tests exercise the replay buffer, not identity.ts's disk writes, and
 * the connection keeps the credential in memory either way.
 */
function connect(host: FakeHost, options: { onLeaseLost?: (leaseId: string, runId: string, reason: string) => void } = {}): WorkerConnection {
  return connectToHost({
    hostUrl: host.url,
    token: "bwp_test-token",
    name: "test worker",
    capabilities: CAPABILITIES,
    activeLeases: () => [],
    onEnrolled: () => {},
    onLeaseLost: options.onLeaseLost,
  });
}

/** A dispatch for the suite's one lease, with whatever deadline the test wants to fence against. */
function dispatchFrame(expiresAt: string): HostMessage {
  return {
    type: "dispatch",
    lease: { id: "lease-a", runId: "run-1", issuedAt: new Date().toISOString(), expiresAt },
    kind: "implementation",
    run: {
      id: "run-1",
      ticket: {
        id: "t-1",
        identifier: "PD-1",
        title: "t",
        description: "d",
        url: "https://example.invalid",
        labels: [],
        state: "In Progress",
        updatedAt: "2026-08-11T10:00:00.000Z",
      },
      status: "queued",
      sandbox: {},
      attempts: [],
      costs: [],
      createdAt: "2026-08-11T10:00:00.000Z",
    },
    repoKey: "brevi",
    repo: repoConfigSchema.parse({ remote: "adapter/brevi" }),
    prompts: { prDescription: "concise", memories: [], recordMemories: false },
    config: configSchema.parse({}),
  };
}

describe("connectToHost with a pre-provisioned identity", () => {
  it("registers with a credential auth envelope, never a pairing token", async () => {
    const host = await startFakeHost();
    // Mirrors what daemon.ts's resolveEnrollment builds from
    // WorkerOptions.enrollment: no token at all, so the very first attempt
    // has to authenticate with the credential straight away.
    const connection = connectToHost({
      hostUrl: host.url,
      enrollment: { workerId: "wk-injected", credential: "bwc_injected-credential", host: host.url },
      name: "test worker",
      capabilities: CAPABILITIES,
      activeLeases: () => [],
    });
    try {
      await waitFor(() => host.sessions.length === 1);
      const session = host.sessions[0]!;
      expect(session.register.auth).toEqual({
        kind: "credential",
        workerId: "wk-injected",
        secret: "bwc_injected-credential",
      });
    } finally {
      connection.close();
      await host.close();
    }
  });

  it("routes an unauthorized rejection through onUnauthorized instead of exiting", async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const address = wss.address();
    const port = typeof address === "object" && address ? address.port : 0;
    wss.on("connection", (socket) => {
      socket.on("message", () => {
        socket.send(JSON.stringify({ type: "rejected", code: "unauthorized", reason: "unknown or revoked credential" }));
      });
    });

    let forgotten = 0;
    let unauthorized = 0;
    const url = `http://127.0.0.1:${port}`;
    const connection = connectToHost({
      hostUrl: url,
      enrollment: { workerId: "wk-injected", credential: "bwc_dead", host: url },
      name: "test worker",
      capabilities: CAPABILITIES,
      activeLeases: () => [],
      forgetCredential: () => {
        forgotten += 1;
      },
      onUnauthorized: () => {
        unauthorized += 1;
      },
    });
    try {
      // A passing test is itself the no-exit assertion: the fatal path this
      // replaces would have killed the whole test process.
      await waitFor(() => unauthorized === 1);
      expect(forgotten).toBe(1);
    } finally {
      connection.close();
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    }
  });
});

describe("connectToHost replay buffer", () => {
  it("stamps reporting frames with per-lease sequence numbers starting at 1, independently per lease", async () => {
    const host = await startFakeHost();
    const connection = connect(host);
    try {
      await waitFor(() => host.sessions.length === 1);

      connection.send(patchFrame("lease-a"));
      connection.send(patchFrame("lease-b"));
      connection.send(eventFrame("lease-a"));

      await waitFor(() => host.received.length === 3);
      const [first, second, third] = host.received;
      expect(first?.type === "run-patch" && (first as { leaseId: string }).leaseId).toBe("lease-a");
      expect(seqOf(first!)).toBe(1);
      expect((second as { leaseId: string }).leaseId).toBe("lease-b");
      expect(seqOf(second!)).toBe(1);
      expect((third as { leaseId: string }).leaseId).toBe("lease-a");
      expect(seqOf(third!)).toBe(2);
    } finally {
      connection.close();
      await host.close();
    }
  });

  it("delivers frames sent while the socket is down after the reconnect, in order", async () => {
    const host = await startFakeHost();
    const connection = connect(host);
    try {
      await waitFor(() => host.sessions.length === 1);
      const first = host.sessions[0]!;

      host.drop(first);

      // Sent entirely while disconnected: nothing to receive yet on either session.
      connection.send(patchFrame("lease-a"));
      connection.send(eventFrame("lease-a", "run-1", "second"));

      await waitFor(() => host.sessions.length === 2);
      const second = host.sessions[1]!;
      host.ack(second, leaseAck(0));

      await waitFor(() => host.received.length === 2);
      expect(host.received[0]?.type).toBe("run-patch");
      expect(seqOf(host.received[0]!)).toBe(1);
      expect(host.received[1]?.type).toBe("run-event");
      expect(seqOf(host.received[1]!)).toBe(2);
    } finally {
      connection.close();
      await host.close();
    }
  });

  it("after a reconnect acking seq 2, resends only frames 3 and up", async () => {
    const host = await startFakeHost();
    const connection = connect(host);
    try {
      await waitFor(() => host.sessions.length === 1);
      host.drop(host.sessions[0]!);

      // Four frames queued entirely while disconnected: seq 1..4.
      connection.send(patchFrame("lease-a"));
      connection.send(eventFrame("lease-a", "run-1", "e2"));
      connection.send(eventFrame("lease-a", "run-1", "e3"));
      connection.send(eventFrame("lease-a", "run-1", "e4"));

      await waitFor(() => host.sessions.length === 2);
      host.ack(host.sessions[1]!, leaseAck(2));

      await waitFor(() => host.received.length === 2);
      expect(host.received.map((m) => seqOf(m))).toEqual([3, 4]);
    } finally {
      connection.close();
      await host.close();
    }
  });

  it("stops buffering a lease once its run-complete-ack arrives, but keeps pendingCount above 0 until then", async () => {
    const host = await startFakeHost();
    const connection = connect(host);
    try {
      await waitFor(() => host.sessions.length === 1);
      const session = host.sessions[0]!;

      connection.send(completeFrame("lease-a"));
      await waitFor(() => host.received.length === 1);
      expect(connection.pendingCount()).toBeGreaterThan(0);

      host.ack(session, { type: "run-complete-ack", leaseId: "lease-a", runId: "run-1" });
      await waitFor(() => connection.pendingCount() === 0);
    } finally {
      connection.close();
      await host.close();
    }
  });

  it("resends an unacknowledged frame when the host's watermark stops moving on a healthy socket", async () => {
    const host = await startFakeHost();
    const connection = connect(host);
    try {
      await waitFor(() => host.sessions.length === 1);
      const session = host.sessions[0]!;

      // A completion whose write failed host-side: it reaches the host, but
      // the host never acknowledges it, and the socket stays up throughout.
      // Nothing else would ever retry this, because handing a frame to the
      // socket marks it delivered and only a disconnect clears that.
      connection.send(completeFrame("lease-a"));
      await waitFor(() => host.received.length === 1);

      // First heartbeat ack: watermark 0. Nothing to conclude yet, one ack is
      // not evidence of a stall.
      host.ack(session, leaseAck(0));
      await settle(200);
      expect(host.received).toHaveLength(1);

      // Second ack with the same watermark: a whole interval with no
      // progress on a frame the host has. The worker resends it.
      host.ack(session, leaseAck(0));
      await waitFor(() => host.received.length === 2);
      expect(host.received[1]?.type).toBe("run-complete");
      expect(seqOf(host.received[1]!)).toBe(1);

      // The retry landed this time, so the host acknowledges it and the
      // buffer empties: the round trip is closed, with no disconnect anywhere
      // in it.
      host.ack(session, { type: "run-complete-ack", leaseId: "lease-a", runId: "run-1" });
      await waitFor(() => connection.pendingCount() === 0);
    } finally {
      connection.close();
      await host.close();
    }
  });

  it("does not resend while the host's watermark keeps advancing", async () => {
    const host = await startFakeHost();
    const connection = connect(host);
    try {
      await waitFor(() => host.sessions.length === 1);
      const session = host.sessions[0]!;

      connection.send(patchFrame("lease-a"));
      connection.send(eventFrame("lease-a", "run-1", "second"));
      connection.send(eventFrame("lease-a", "run-1", "third"));
      await waitFor(() => host.received.length === 3);

      // Acks that move: normal operation, where the watermark simply trails
      // the newest frames while their writes land. Resending on every one of
      // these would double the host's whole reporting stream.
      host.ack(session, leaseAck(1));
      await settle(150);
      host.ack(session, leaseAck(2));
      await settle(150);
      expect(host.received).toHaveLength(3);
    } finally {
      connection.close();
      await host.close();
    }
  });

  it("holds new reporting frames for an already-claimed lease until its lease-ack arrives after a reconnect", async () => {
    const host = await startFakeHost();
    const connection = connect(host);
    try {
      await waitFor(() => host.sessions.length === 1);
      // The lease is already known to the connection (seq 1 delivered)
      // before the drop, same as a lease a worker claimed before the socket
      // dropped; a lease it never heard of before this session is a
      // different case (a fresh dispatch), not what "awaitingAck" gates.
      connection.send(patchFrame("lease-a"));
      await waitFor(() => host.received.length === 1);

      host.drop(host.sessions[0]!);
      await waitFor(() => host.sessions.length === 2);
      const second = host.sessions[1]!;

      // registered, but no lease-ack yet: a new frame for that still-open
      // lease must not reach the host before the host says where it got to.
      connection.send(eventFrame("lease-a", "run-1", "held"));
      await settle(300);
      expect(host.received).toHaveLength(1); // still just the pre-drop frame

      host.ack(second, leaseAck(1));
      await waitFor(() => host.received.length === 2);
      expect(host.received[1]?.type).toBe("run-event");
      expect(seqOf(host.received[1]!)).toBe(2);
    } finally {
      connection.close();
      await host.close();
    }
  });

  it("announces the range it dropped when the buffer overflows, so the host can step over it", async () => {
    const host = await startFakeHost();
    const connection = connect(host);
    try {
      await waitFor(() => host.sessions.length === 1);
      const session = host.sessions[0]!;

      // Nothing is acknowledged, so every frame stays buffered and the cap
      // eventually has to give. Dropping punches a hole in the sequence
      // numbers, and the host's watermark will not cross a hole on its own.
      for (let i = 0; i < WORKER_REPLAY_BUFFER_LIMIT + 50; i++) {
        connection.send(eventFrame("lease-a", "run-1", `line ${i}`));
      }

      await waitFor(() => host.received.some((message) => message.type === "lease-gap"));
      const gap = host.received.find((message) => message.type === "lease-gap");
      expect(gap).toMatchObject({ type: "lease-gap", leaseId: "lease-a", runId: "run-1" });
      if (gap?.type !== "lease-gap") throw new Error("expected a lease-gap");
      expect(gap.dropped).toBeGreaterThan(0);

      // What it gives up on is exactly the range below the oldest frame it
      // still holds, so the host is never told to skip something the worker
      // could still deliver.
      const reported = host.received.filter((message) => "seq" in message && message.seq !== undefined);
      const oldestHeld = Math.min(
        ...reported.filter((message) => (seqOf(message) ?? 0) > gap.throughSeq).map((message) => seqOf(message) ?? 0),
      );
      expect(gap.throughSeq).toBe(oldestHeld - 1);

      // Acking through the gap plus everything still held drains the buffer:
      // it converges rather than growing forever behind a stuck watermark.
      host.ack(session, { ...leaseAck(0), seq: 100_000 });
      await waitFor(() => connection.pendingCount() === 0);
    } finally {
      connection.close();
      await host.close();
    }
  });

  it("re-announces a dropped range on reconnect, in case the host lost its watermark", async () => {
    const host = await startFakeHost();
    const connection = connect(host);
    try {
      await waitFor(() => host.sessions.length === 1);
      for (let i = 0; i < WORKER_REPLAY_BUFFER_LIMIT + 10; i++) {
        connection.send(eventFrame("lease-a", "run-1", `line ${i}`));
      }
      await waitFor(() => host.received.some((message) => message.type === "lease-gap"));
      const before = host.received.filter((message) => message.type === "lease-gap").length;

      host.drop(host.sessions[0]!);
      await waitFor(() => host.sessions.length === 2);

      // A host that restarted before its watermark write landed is back to
      // waiting for frames nobody has; only this frame can tell it to stop.
      await waitFor(() => host.received.filter((message) => message.type === "lease-gap").length > before);
    } finally {
      connection.close();
      await host.close();
    }
  });

  it("abandons a run whose lease passed its deadline with the host out of reach", async () => {
    const host = await startFakeHost();
    const lost: { leaseId: string; runId: string }[] = [];
    const connection = connect(host, { onLeaseLost: (leaseId, runId) => lost.push({ leaseId, runId }) });
    try {
      await waitFor(() => host.sessions.length === 1);

      // A deadline already in the past: the host has been unreachable for
      // longer than it was ever going to wait, so it has written this lease
      // off and may have given the run to another worker. Nothing the host
      // sends can reach a worker in that state, so the worker has to be the
      // one to stop.
      host.ack(host.sessions[0]!, dispatchFrame(new Date(Date.now() - 1_000).toISOString()));

      await waitFor(() => lost.length === 1, 15_000);
      expect(lost[0]).toEqual({ leaseId: "lease-a", runId: "run-1" });
    } finally {
      connection.close();
      await host.close();
    }
  }, 20_000);

  it("keeps a run whose lease the host keeps renewing", async () => {
    const host = await startFakeHost();
    const lost: string[] = [];
    const connection = connect(host, { onLeaseLost: (leaseId) => lost.push(leaseId) });
    try {
      await waitFor(() => host.sessions.length === 1);
      const session = host.sessions[0]!;

      // Due imminently, then renewed the way a heartbeat's ack renews it.
      host.ack(session, dispatchFrame(new Date(Date.now() + 300).toISOString()));
      host.ack(session, { ...leaseAck(0), expiresAt: new Date(Date.now() + 600_000).toISOString() });

      await settle(1_000);
      expect(lost).toEqual([]);
    } finally {
      connection.close();
      await host.close();
    }
  });

  it("abandons a run the host takes back with lease-lost, and stops replaying it", async () => {
    const host = await startFakeHost();
    const lost: { leaseId: string; reason: string }[] = [];
    const connection = connect(host, { onLeaseLost: (leaseId, _runId, reason) => lost.push({ leaseId, reason }) });
    try {
      await waitFor(() => host.sessions.length === 1);
      const session = host.sessions[0]!;

      connection.send(patchFrame("lease-a"));
      await waitFor(() => host.received.length === 1);
      expect(connection.pendingCount()).toBeGreaterThan(0);

      host.ack(session, { type: "lease-lost", leaseId: "lease-a", runId: "run-1", reason: "the run is no longer yours" });

      await waitFor(() => lost.length === 1);
      expect(lost[0]?.reason).toBe("the run is no longer yours");
      // The buffer goes with it: nothing about a lease this worker no longer
      // holds is worth sending, and the host would refuse it anyway.
      await waitFor(() => connection.pendingCount() === 0);
    } finally {
      connection.close();
      await host.close();
    }
  });
});
