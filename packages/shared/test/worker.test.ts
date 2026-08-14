import { describe, expect, it } from "bun:test";
import { configSchema, repoConfigSchema } from "../src/config.js";
import type { Run, RunEvent, Ticket } from "../src/types.js";
import {
  MACOS_VM_OS,
  parseHostMessage,
  parseWorkerMessage,
  resolveWorkerOs,
  runEventSchema,
  runPatchSchema,
  runSchema,
  WORKER_MAX_CONCURRENCY,
  WORKER_OS_ENV,
  WORKER_PROTOCOL_VERSION,
  type HostMessage,
  type WorkerMessage,
} from "../src/worker.js";

// Run with `bun test packages/shared` from the repo root. This is the
// contract every other fleet ticket builds against, so each message is
// checked the way it actually travels: serialized to JSON, parsed back, and
// validated by the schema the receiving side uses. A field that JSON drops
// (or that a schema quietly rejects) fails here rather than in a live run.

/** Serialize and validate as the receiving host would, then compare with what was sent. */
function roundTripToHost(message: WorkerMessage): WorkerMessage {
  const decoded = parseWorkerMessage(JSON.parse(JSON.stringify(message)));
  expect(decoded).toBeDefined();
  return decoded!;
}

/** Serialize and validate as the receiving worker would. */
function roundTripToWorker(message: HostMessage): HostMessage {
  const decoded = parseHostMessage(JSON.parse(JSON.stringify(message)));
  expect(decoded).toBeDefined();
  return decoded!;
}

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

const run: Run = {
  id: "run-1",
  ticket,
  status: "running",
  sandbox: { provider: "bwrap", workerId: "worker-1", id: "sbx-1" },
  createdAt: "2026-08-11T10:00:00.000Z",
  queuedAt: "2026-08-11T10:00:01.000Z",
  startedAt: "2026-08-11T10:00:02.000Z",
  attempts: [{ number: 1, startedAt: "2026-08-11T10:00:02.000Z" }],
  costs: [],
};

const config = configSchema.parse({});
const repo = repoConfigSchema.parse({ remote: "adapter/brevi" });

describe("the run schema", () => {
  it("accepts a queued run carrying why it has not been dispatched yet", () => {
    const queued = { ...run, status: "queued" as const, queueReason: "no worker is connected" };
    expect(runSchema.parse(JSON.parse(JSON.stringify(queued)))).toEqual(queued);
  });
});

describe("dispatch", () => {
  it("carries the ticket, repo, prompts, agent config and per-run credentials", () => {
    const credentialed = configSchema.parse({
      ...config,
      github: { ...config.github, token: "gh-token" },
      agent: { ...config.agent, anthropicApiKey: "sk-ant" },
    });
    const decoded = roundTripToWorker({
      type: "dispatch",
      lease: { id: "lease-1", runId: run.id, issuedAt: "2026-08-11T10:00:01.000Z" },
      kind: "implementation",
      run,
      repoKey: "brevi",
      repo,
      prompts: { prDescription: "detailed", memories: ["bun test is the runner"], recordMemories: true },
      config: credentialed,
    });

    expect(decoded.type).toBe("dispatch");
    if (decoded.type !== "dispatch") return;
    expect(decoded.run.ticket.identifier).toBe("PD-53");
    expect(decoded.repo.remote).toBe("adapter/brevi");
    expect(decoded.prompts).toEqual({
      prDescription: "detailed",
      memories: ["bun test is the runner"],
      recordMemories: true,
    });
    expect(decoded.config.agent.command).toBe(config.agent.command);
    expect(decoded.config.github.token).toBe("gh-token");
    expect(decoded.config.agent.anthropicApiKey).toBe("sk-ant");
  });

  it("defaults the prompt payload's optional halves", () => {
    const decoded = parseHostMessage({
      type: "dispatch",
      lease: { id: "lease-1", runId: run.id, issuedAt: "2026-08-11T10:00:01.000Z" },
      kind: "follow-up",
      run,
      repoKey: "brevi",
      repo,
      prompts: { prDescription: "concise" },
      config,
    });
    expect(decoded?.type).toBe("dispatch");
    if (decoded?.type !== "dispatch") return;
    expect(decoded.prompts.memories).toEqual([]);
    expect(decoded.prompts.recordMemories).toBe(false);
  });
});

describe("registration", () => {
  it("round-trips a worker's capabilities and the leases it still claims", () => {
    const decoded = roundTripToHost({
      type: "register",
      protocolVersion: WORKER_PROTOCOL_VERSION,
      auth: { kind: "pairing", token: "bwp_pairing" },
      name: "builder",
      capabilities: {
        os: "linux",
        arch: "x64",
        provider: "bwrap",
        agentCommands: ["claude", "codex"],
        maxConcurrency: 4,
        version: "0.5.0",
      },
      activeLeases: [{ id: "lease-1", runId: run.id, issuedAt: "2026-08-11T10:00:01.000Z" }],
    });
    expect(decoded.type).toBe("register");
    if (decoded.type !== "register") return;
    expect(decoded.activeLeases).toHaveLength(1);
    // Identity comes from the auth envelope, never from a field the worker
    // fills in for itself: the register frame has no workerId of its own.
    expect(decoded.auth).toEqual({ kind: "pairing", token: "bwp_pairing" });
  });

  it("round-trips a returning worker's durable credential", () => {
    const decoded = roundTripToHost({
      type: "register",
      protocolVersion: WORKER_PROTOCOL_VERSION,
      auth: { kind: "credential", workerId: "wk-abc123", secret: "bwc_secret" },
      name: "builder",
      capabilities: {
        os: "darwin",
        arch: "arm64",
        provider: "bwrap",
        agentCommands: ["claude"],
        maxConcurrency: 1,
        version: "0.5.0",
      },
      activeLeases: [],
    });
    expect(decoded.type).toBe("register");
    if (decoded.type !== "register") return;
    expect(decoded.auth).toEqual({ kind: "credential", workerId: "wk-abc123", secret: "bwc_secret" });
  });

  it("refuses an auth envelope that is neither kind", () => {
    const base = {
      type: "register",
      protocolVersion: WORKER_PROTOCOL_VERSION,
      name: "builder",
      capabilities: {
        os: "linux",
        arch: "x64",
        provider: "bwrap" as const,
        agentCommands: ["claude"],
        maxConcurrency: 1,
        version: "0.5.0",
      },
      activeLeases: [],
    };
    expect(parseWorkerMessage({ ...base, auth: { kind: "none" } })).toBeUndefined();
    expect(parseWorkerMessage({ ...base, auth: { kind: "pairing", token: "" } })).toBeUndefined();
    expect(parseWorkerMessage({ ...base, auth: { kind: "credential", workerId: "wk-1" } })).toBeUndefined();
  });

  it("refuses a worker that is not bwrap", () => {
    const registration = {
      type: "register",
      protocolVersion: WORKER_PROTOCOL_VERSION,
      auth: { kind: "pairing" as const, token: "bwp_pairing" },
      name: "builder",
      capabilities: {
        os: "linux",
        arch: "x64",
        provider: "legacy",
        agentCommands: ["claude"],
        maxConcurrency: 1,
        version: "0.5.0",
      },
      activeLeases: [],
    };
    expect(parseWorkerMessage(registration)).toBeUndefined();
  });

  it("rejects a concurrency the CLI must refuse too", () => {
    const registration = {
      type: "register",
      protocolVersion: WORKER_PROTOCOL_VERSION,
      auth: { kind: "pairing" as const, token: "bwp_pairing" },
      name: "builder",
      capabilities: {
        os: "linux",
        arch: "x64",
        provider: "bwrap" as const,
        agentCommands: ["claude"],
        maxConcurrency: WORKER_MAX_CONCURRENCY + 1,
        version: "0.5.0",
      },
      activeLeases: [],
    };
    expect(parseWorkerMessage(registration)).toBeUndefined();
    expect(
      parseWorkerMessage({
        ...registration,
        capabilities: { ...registration.capabilities, maxConcurrency: WORKER_MAX_CONCURRENCY },
      }),
    ).toBeDefined();
  });
});

describe("the run event stream", () => {
  const events: RunEvent[] = [
    { runId: run.id, ts: "2026-08-11T10:00:03.000Z", type: "status", status: "running" },
    { runId: run.id, ts: "2026-08-11T10:00:04.000Z", type: "log", stream: "stdout", text: "cloning" },
    { runId: run.id, ts: "2026-08-11T10:00:05.000Z", type: "agent", event: { type: "assistant" } },
    { runId: run.id, ts: "2026-08-11T10:00:06.000Z", type: "thinking", phase: "finished", durationMs: 1200 },
    {
      runId: run.id,
      ts: "2026-08-11T10:00:07.000Z",
      type: "artifact",
      artifact: { name: "demo.png", type: "screenshot", size: 2048 },
    },
    {
      runId: run.id,
      ts: "2026-08-11T10:00:08.000Z",
      type: "cost",
      entry: { label: "implementation", provider: "claude", inputTokens: 10, outputTokens: 20 },
    },
    {
      runId: run.id,
      ts: "2026-08-11T10:00:09.000Z",
      type: "limit",
      limit: {
        provider: "claude",
        kind: "five-hour",
        resetsAt: "2026-08-11T14:00:00.000Z",
        message: "usage limit reached",
      },
    },
    { runId: run.id, ts: "2026-08-11T10:00:10.000Z", type: "attempt", number: 2 },
  ];

  for (const event of events) {
    it(`carries a ${event.type} event unchanged`, () => {
      expect(runEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
      const decoded = roundTripToHost({ type: "run-event", leaseId: "lease-1", runId: run.id, event });
      expect(decoded.type).toBe("run-event");
      if (decoded.type !== "run-event") return;
      expect(decoded.event).toEqual(event);
    });
  }

  it("carries its replay sequence number, so the host can apply it idempotently", () => {
    const decoded = roundTripToHost({
      type: "run-event",
      leaseId: "lease-1",
      runId: run.id,
      event: events[0]!,
      seq: 7,
    });
    expect(decoded.type).toBe("run-event");
    if (decoded.type !== "run-event") return;
    expect(decoded.seq).toBe(7);
  });

  it("still parses without a seq, from a worker that predates buffered replay", () => {
    const decoded = roundTripToHost({ type: "run-event", leaseId: "lease-1", runId: run.id, event: events[0]! });
    expect(decoded.type).toBe("run-event");
    if (decoded.type !== "run-event") return;
    expect(decoded.seq).toBeUndefined();
  });
});

describe("run patches", () => {
  it("distinguishes clearing a field from leaving it alone", () => {
    const patch = runPatchSchema.parse(JSON.parse(JSON.stringify({ error: null, status: "running" })));
    expect(patch).toEqual({ error: null, status: "running" });
    expect("finishedAt" in patch).toBe(false);
  });

  it("treats the sandbox as a merge patch with no worker id on it", () => {
    // workerId is the host's to write, from the lease: a worker reporting its
    // sandbox must not be able to drop or reassign ownership of the run.
    const patch = runPatchSchema.parse({ sandbox: { id: "vm-1", workerId: "someone-else" } });
    expect(patch.sandbox).toEqual({ id: "vm-1" });
    // Every sandbox field retracts the same way the top-level ones do, so a
    // worker that destroyed a sandbox can take back the id it reported.
    expect(runPatchSchema.parse({ sandbox: { retainedUntil: null } }).sandbox).toEqual({ retainedUntil: null });
    expect(runPatchSchema.parse({ sandbox: { id: null, provider: null } }).sandbox).toEqual({
      id: null,
      provider: null,
    });
  });
});

describe("completion", () => {
  it("carries the result, artifacts and PR information of a finished run", () => {
    const decoded = roundTripToHost({
      type: "run-complete",
      leaseId: "lease-1",
      runId: run.id,
      outcome: "completed",
      finishedAt: "2026-08-11T10:30:00.000Z",
      result: {
        summary: "shipped it",
        prUrl: "https://github.com/adapter/brevi/pull/74",
        branch: "brevi/pd-53",
        pushedAt: "2026-08-11T10:29:00.000Z",
        artifacts: [{ name: "demo.png", type: "screenshot", size: 2048 }],
      },
      artifacts: [{ name: "demo.png", type: "screenshot", size: 2048 }],
      prUrl: "https://github.com/adapter/brevi/pull/74",
      prState: "draft",
      attempts: [
        { number: 1, startedAt: "2026-08-11T10:00:02.000Z", finishedAt: "2026-08-11T10:30:00.000Z", outcome: "completed" },
      ],
      costs: [{ label: "implementation", provider: "claude", inputTokens: 10, outputTokens: 20 }],
      costTotals: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimated: false,
      },
      agentSessionId: "session-1",
      sandbox: { provider: "bwrap", id: "sbx-1", retainedUntil: "2026-08-11T12:30:00.000Z" },
    });

    expect(decoded.type).toBe("run-complete");
    if (decoded.type !== "run-complete") return;
    expect(decoded.outcome).toBe("completed");
    expect(decoded.result?.prUrl).toBe("https://github.com/adapter/brevi/pull/74");
    expect(decoded.artifacts).toHaveLength(1);
    expect(decoded.prState).toBe("draft");
    expect(decoded.sandbox?.retainedUntil).toBe("2026-08-11T12:30:00.000Z");
  });

  it("carries the limit a run parked on", () => {
    const decoded = roundTripToHost({
      type: "run-complete",
      leaseId: "lease-1",
      runId: run.id,
      outcome: "waiting",
      limit: { provider: "claude", kind: "weekly", message: "usage limit reached" },
      resumeAt: "2026-08-12T10:00:00.000Z",
      artifacts: [],
      attempts: [],
      costs: [],
    });
    expect(decoded.type).toBe("run-complete");
    if (decoded.type !== "run-complete") return;
    expect(decoded.limit?.kind).toBe("weekly");
    expect(decoded.resumeAt).toBe("2026-08-12T10:00:00.000Z");
  });

  it("defaults its list fields, so a minimal completion still parses", () => {
    const decoded = parseWorkerMessage({
      type: "run-complete",
      leaseId: "lease-1",
      runId: run.id,
      outcome: "failed",
      error: "the agent made no changes",
    });
    expect(decoded?.type).toBe("run-complete");
    if (decoded?.type !== "run-complete") return;
    expect(decoded.artifacts).toEqual([]);
    expect(decoded.costs).toEqual([]);
    expect(decoded.attempts).toEqual([]);
  });

  it("is acknowledged, which is what lets a worker release the lease", () => {
    const decoded = roundTripToWorker({ type: "run-complete-ack", leaseId: "lease-1", runId: run.id });
    expect(decoded.type).toBe("run-complete-ack");
  });
});

describe("lease-ack", () => {
  it("tells the worker how far the host has applied a lease's reporting stream", () => {
    const decoded = roundTripToWorker({
      type: "lease-ack",
      leaseId: "lease-1",
      runId: run.id,
      seq: 3,
      expiresAt: "2026-08-11T10:05:00.000Z",
    });
    expect(decoded.type).toBe("lease-ack");
    if (decoded.type !== "lease-ack") return;
    expect(decoded.seq).toBe(3);
  });

  it("rejects a negative seq", () => {
    expect(
      parseHostMessage({ type: "lease-ack", leaseId: "lease-1", runId: run.id, seq: -1, expiresAt: "2026-08-11T10:05:00.000Z" }),
    ).toBeUndefined();
  });
});

describe("the rest of the contract", () => {
  const workerMessages: WorkerMessage[] = [
    { type: "heartbeat", ts: "2026-08-11T10:00:15.000Z", leaseIds: ["lease-1"] },
    { type: "dispatch-accepted", leaseId: "lease-1", runId: run.id },
    { type: "dispatch-rejected", leaseId: "lease-1", runId: run.id, reason: "worker at capacity" },
    { type: "run-patch", leaseId: "lease-1", runId: run.id, patch: { status: "preparing" } },
    {
      type: "run-artifact",
      leaseId: "lease-1",
      runId: run.id,
      artifact: { name: "demo.png", type: "screenshot", size: 3 },
      data: Buffer.from("png").toString("base64"),
    },
    { type: "run-memories", leaseId: "lease-1", runId: run.id, repo: "adapter/brevi", learned: ["bun test"] },
    { type: "worker-log", level: "warn", message: "kvm is missing" },
    { type: "attach-data", attachId: "attach-1", data: "$ " },
    { type: "attach-exit", attachId: "attach-1", code: 0 },
    { type: "attach-error", attachId: "attach-1", message: "no retained disk" },
  ];

  for (const message of workerMessages) {
    it(`round-trips ${message.type} to the host`, () => {
      expect(roundTripToHost(message)).toMatchObject(message);
    });
  }

  const hostMessages: HostMessage[] = [
    {
      type: "registered",
      protocolVersion: WORKER_PROTOCOL_VERSION,
      heartbeatIntervalMs: 15_000,
      hostVersion: "0.5.0",
      workerId: "wk-abc123",
      name: "builder",
      state: "active",
      credential: "bwc_secret",
    },
    { type: "rejected", code: "invalid-token", reason: "the pairing token was not accepted" },
    { type: "cancel", leaseId: "lease-1", runId: run.id },
    { type: "discard", runId: run.id },
    { type: "heartbeat-ack", ts: "2026-08-11T10:00:15.000Z", state: "draining" },
    { type: "worker-state", state: "draining" },
    { type: "revoked", reason: "This worker's enrollment was revoked." },
    { type: "attach-open", attachId: "attach-1", runId: run.id, config, cols: 120, rows: 40 },
    { type: "attach-input", attachId: "attach-1", data: "ls\n" },
    { type: "attach-resize", attachId: "attach-1", cols: 100, rows: 30 },
    { type: "attach-close", attachId: "attach-1" },
  ];

  for (const message of hostMessages) {
    it(`round-trips ${message.type} to the worker`, () => {
      expect(roundTripToWorker(message)).toMatchObject(message);
    });
  }

  it("ignores a frame that is not part of the contract", () => {
    expect(parseWorkerMessage({ type: "definitely-not-a-message" })).toBeUndefined();
    expect(parseHostMessage({ type: "dispatch" })).toBeUndefined();
    expect(parseWorkerMessage(undefined)).toBeUndefined();
  });
});

describe("resolveWorkerOs", () => {
  it("passes process.platform through when the env var is unset", () => {
    expect(resolveWorkerOs("linux", {})).toBe("linux");
    expect(resolveWorkerOs("darwin", { SOMETHING_ELSE: "1" })).toBe("darwin");
  });

  it("reports macos-vm when the managed guest VM's worker sets the override, whitespace and case included", () => {
    expect(resolveWorkerOs("linux", { [WORKER_OS_ENV]: "macos-vm" })).toBe(MACOS_VM_OS);
    expect(resolveWorkerOs("linux", { [WORKER_OS_ENV]: "  macos-vm  " })).toBe(MACOS_VM_OS);
    expect(resolveWorkerOs("linux", { [WORKER_OS_ENV]: "MACOS-VM" })).toBe(MACOS_VM_OS);
    expect(resolveWorkerOs("linux", { [WORKER_OS_ENV]: " Macos-Vm " })).toBe(MACOS_VM_OS);
  });

  it("is a whitelist, not a passthrough: any other value is ignored", () => {
    expect(resolveWorkerOs("linux", { [WORKER_OS_ENV]: "darwin" })).toBe("linux");
    expect(resolveWorkerOs("linux", { [WORKER_OS_ENV]: "windows" })).toBe("linux");
    expect(resolveWorkerOs("linux", { [WORKER_OS_ENV]: "" })).toBe("linux");
  });
});
