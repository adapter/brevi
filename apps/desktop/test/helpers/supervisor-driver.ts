// Scenario runner for the supervisor's concurrent-start integration tests.
// Spawned as its own subprocess by supervisor.test.ts, with HOME set on that
// spawn's real environment: Bun's os.homedir() (which @brevi/shared's
// BREVI_HOME, and so @brevi/orchestrator/pid's pid file path, is computed
// from) only honours HOME present on the process's environment at startup,
// not process.env mutated at runtime. Driving the real, in-process
// OrchestratorSupervisor from a plain bun:test file would therefore read and
// write the real ~/.brevi/server.pid; running the scenario in a freshly
// spawned process with HOME genuinely overridden avoids that entirely.
//
// Runs exactly one scenario (named by the SCENARIO env var) against a real
// OrchestratorSupervisor and one or two fake-orchestrator.ts children, then
// prints a single JSON line describing the outcome and exits.
import { spawn, type ChildProcess } from "node:child_process";
import { OrchestratorSupervisor, type SupervisorState } from "../../src/main/supervisor.js";

const scenario = process.env.SCENARIO;
const port = Number(process.env.PORT);
const fakeEntry = process.env.FAKE_ORCHESTRATOR_ENTRY;
const runtime = process.execPath;
const url = `http://127.0.0.1:${port}`;

if (!scenario || !fakeEntry || !Number.isInteger(port)) {
  throw new Error("supervisor-driver requires SCENARIO, PORT and FAKE_ORCHESTRATOR_ENTRY");
}

// The real OrchestratorSupervisor spawns its own child with
// `{ ...process.env, ... }` (see spawnOwn), so FAKE_PORT has to be on this
// process's own env for that child (as opposed to ones spawnFake() spawns
// directly below, which get it explicitly) to bind the right port.
process.env.FAKE_PORT = String(port);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnFake(env: Record<string, string>): ChildProcess {
  const child = spawn(runtime, [fakeEntry], {
    env: { ...process.env, FAKE_PORT: String(port), ...env },
    stdio: "ignore",
  });
  spawned.push(child);
  return child;
}

async function probeHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(500) });
    if (!res.ok) return false;
    const body = (await res.json()) as Record<string, unknown>;
    return body.ok === true;
  } catch {
    return false;
  }
}

async function waitUntilHealthy(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeHealthy()) return true;
    await sleep(100);
  }
  return false;
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  return predicate();
}

interface Outcome {
  ok: boolean;
  states: SupervisorState[];
  finalState: SupervisorState;
  ownsProcess: boolean;
  pid: number | null;
  detail?: string;
}

const spawned: ChildProcess[] = [];

function killAll(): void {
  for (const child of spawned) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
}

async function run(): Promise<Outcome> {
  const states: SupervisorState[] = [];
  const supervisor = new OrchestratorSupervisor({
    cliEntry: fakeEntry as string,
    runtime,
    url,
    onState: (state) => states.push(state),
  });

  if (scenario === "already-healthy") {
    spawnFake({});
    const up = await waitUntilHealthy(5000);
    if (!up) {
      return {
        ok: false,
        states,
        finalState: supervisor.state,
        ownsProcess: false,
        pid: null,
        detail: "external fake never became healthy",
      };
    }

    await supervisor.start();
    const ok = supervisor.state.kind === "attached" && !supervisor.ownsProcess;
    return { ok, states, finalState: supervisor.state, ownsProcess: supervisor.ownsProcess, pid: supervisor.pid };
  }

  if (scenario === "adopt-delayed-health") {
    spawnFake({ FAKE_HEALTH_DELAY_MS: "1200" });
    // Give it a head start to write its pid file, well before it's healthy.
    await sleep(150);
    await supervisor.start();
    const ok = supervisor.state.kind === "attached" && !supervisor.ownsProcess;
    return { ok, states, finalState: supervisor.state, ownsProcess: supervisor.ownsProcess, pid: supervisor.pid };
  }

  if (scenario === "own-exit-external-healthy") {
    // Our own child waits before deciding whether to bind, so there's a
    // window in which an external instance can win the port.
    process.env.FAKE_STARTUP_DELAY_MS = "700";
    const startPromise = supervisor.start();
    await sleep(100);
    spawnFake({ FAKE_STARTUP_DELAY_MS: "0", FAKE_HEALTH_DELAY_MS: "0" });
    await startPromise.catch(() => undefined);

    const reachedAttached = await waitUntil(() => supervisor.state.kind === "attached", 5000);
    const neverFailedOrRestarted = !states.some((s) => s.kind === "failed" || s.kind === "restarting");
    const ok = reachedAttached && neverFailedOrRestarted && !supervisor.ownsProcess;
    return {
      ok,
      states,
      finalState: supervisor.state,
      ownsProcess: supervisor.ownsProcess,
      pid: supervisor.pid,
      detail: ok ? undefined : `reachedAttached=${reachedAttached} neverFailedOrRestarted=${neverFailedOrRestarted}`,
    };
  }

  if (scenario === "sigterm-idle") {
    process.env.FAKE_STARTUP_DELAY_MS = "0";
    await supervisor.start();
    if (supervisor.state.kind !== "running") {
      return {
        ok: false,
        states,
        finalState: supervisor.state,
        ownsProcess: supervisor.ownsProcess,
        pid: supervisor.pid,
        detail: "did not reach running before the sigterm-idle probe",
      };
    }

    const pid = supervisor.pid;
    if (pid !== null) process.kill(pid, "SIGTERM");
    const reachedIdle = await waitUntil(() => supervisor.state.kind === "idle", 5000);
    // Give it a beat to prove it doesn't spawn a replacement on its own.
    await sleep(1000);
    const stayedIdle = supervisor.state.kind === "idle";
    return {
      ok: reachedIdle && stayedIdle,
      states,
      finalState: supervisor.state,
      ownsProcess: supervisor.ownsProcess,
      pid: supervisor.pid,
    };
  }

  if (scenario === "hard-crash") {
    process.env.FAKE_STARTUP_DELAY_MS = "0";
    await supervisor.start();
    if (supervisor.state.kind !== "running") {
      return {
        ok: false,
        states,
        finalState: supervisor.state,
        ownsProcess: supervisor.ownsProcess,
        pid: supervisor.pid,
        detail: "did not reach running before the hard-crash probe",
      };
    }

    const pid = supervisor.pid;
    if (pid !== null) process.kill(pid, "SIGKILL");
    const reachedRestarting = await waitUntil(
      () => supervisor.state.kind === "restarting" || supervisor.state.kind === "failed",
      5000,
    );
    return {
      ok: reachedRestarting,
      states,
      finalState: supervisor.state,
      ownsProcess: supervisor.ownsProcess,
      pid: supervisor.pid,
    };
  }

  return {
    ok: false,
    states,
    finalState: supervisor.state,
    ownsProcess: false,
    pid: null,
    detail: `unknown scenario "${scenario}"`,
  };
}

// process.exit() below terminates immediately, taking any leftover timers
// (a pending restart backoff, an attach/idle poll) down with it, so there's
// nothing further to cancel once the outcome is printed.
run()
  .then((outcome) => {
    killAll();
    process.stdout.write(JSON.stringify(outcome));
    process.exit(0);
  })
  .catch((err: unknown) => {
    killAll();
    process.stdout.write(
      JSON.stringify({
        ok: false,
        states: [],
        finalState: null,
        ownsProcess: false,
        pid: null,
        detail: err instanceof Error ? err.message : String(err),
      }),
    );
    process.exit(1);
  });
