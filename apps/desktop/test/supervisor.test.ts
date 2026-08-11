import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Concurrent-start integration tests for OrchestratorSupervisor (findings 4
// and 5 from the desktop app review): each scenario runs in its own
// subprocess (see helpers/supervisor-driver.ts) driven against a fake
// orchestrator (helpers/fake-orchestrator.ts), never the real CLI, and each
// gets a throwaway $HOME so nothing here touches the real ~/.brevi.

const here = dirname(fileURLToPath(import.meta.url));
const driverEntry = join(here, "helpers", "supervisor-driver.ts");
const fakeEntry = join(here, "helpers", "fake-orchestrator.ts");

const DRIVER_TIMEOUT_MS = 20_000;

/** A free localhost port, found by binding to port 0 and reading back what the OS assigned. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("could not allocate a free port"));
      });
    });
    server.on("error", reject);
  });
}

interface Outcome {
  ok: boolean;
  states: { kind: string }[];
  finalState: { kind: string } | null;
  ownsProcess: boolean;
  pid: number | null;
  detail?: string;
}

/** Runs one supervisor-driver.ts scenario in an isolated subprocess (own $HOME, own port) and parses its JSON outcome. */
async function runScenario(scenario: string): Promise<Outcome> {
  const home = mkdtempSync(join(tmpdir(), "brevi-supervisor-test-"));
  try {
    const port = await freePort();
    const child = spawn(process.execPath, [driverEntry], {
      env: {
        ...process.env,
        HOME: home,
        SCENARIO: scenario,
        PORT: String(port),
        FAKE_ORCHESTRATOR_ENTRY: fakeEntry,
      },
      stdio: ["ignore", "pipe", "inherit"],
    });

    let stdout = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`driver for scenario "${scenario}" timed out after ${DRIVER_TIMEOUT_MS}ms`));
      }, DRIVER_TIMEOUT_MS);
      child.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    if (stdout.trim() === "") {
      throw new Error(`driver for scenario "${scenario}" produced no output`);
    }
    return JSON.parse(stdout) as Outcome;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("OrchestratorSupervisor concurrent start (integration)", () => {
  test("a server already healthy on the port: start() attaches without spawning", async () => {
    const outcome = await runScenario("already-healthy");
    expect(outcome.detail).toBeUndefined();
    expect(outcome.finalState?.kind).toBe("attached");
    expect(outcome.ownsProcess).toBe(false);
    expect(outcome.pid).not.toBeNull();
    expect(outcome.ok).toBe(true);
  });

  test("a live pid whose server becomes healthy a moment later is adopted, not double-started", async () => {
    const outcome = await runScenario("adopt-delayed-health");
    expect(outcome.detail).toBeUndefined();
    expect(outcome.finalState?.kind).toBe("attached");
    expect(outcome.ownsProcess).toBe(false);
    expect(outcome.ok).toBe(true);
  });

  test("own child exits 0 while an external server is healthy: attaches, spends no restart attempt", async () => {
    const outcome = await runScenario("own-exit-external-healthy");
    expect(outcome.detail).toBeUndefined();
    expect(outcome.finalState?.kind).toBe("attached");
    expect(outcome.states.some((s) => s.kind === "failed")).toBe(false);
    expect(outcome.states.some((s) => s.kind === "restarting")).toBe(false);
    expect(outcome.ok).toBe(true);
  });

  test("SIGTERM with nothing else healthy: goes idle and does not respawn on its own", async () => {
    const outcome = await runScenario("sigterm-idle");
    expect(outcome.detail).toBeUndefined();
    expect(outcome.finalState?.kind).toBe("idle");
    expect(outcome.ok).toBe(true);
  });

  test("a hard crash with nothing healthy still schedules a restart", async () => {
    const outcome = await runScenario("hard-crash");
    expect(outcome.detail).toBeUndefined();
    expect(["restarting", "failed"]).toContain(outcome.finalState?.kind);
    expect(outcome.ok).toBe(true);
  });
});
