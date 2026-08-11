// Fake orchestrator for the supervisor's concurrent-start integration tests.
// Mimics just enough of `brevi start`'s real behavior for
// OrchestratorSupervisor to be driven against it without touching the real
// CLI, a real sandbox, or ~/.brevi:
//   - checks whether something already answers healthily on the port before
//     binding, and exits 0 without binding if so (the same "attach instead
//     of double-starting" check runServer does via orchestratorAlreadyRunning)
//   - serves /api/health in the exact shape isHealthResponse accepts
//   - writes the real pid file (via @brevi/orchestrator/pid's writePidFile)
//   - exits 0 on SIGTERM/SIGINT after closing its server
//
// Configured entirely through env vars: the real cliEntry only ever gets
// "start" as argv (see supervisor.ts's spawnOwn), so there's no argv channel
// for per-scenario config.
//   FAKE_PORT              required: port to probe/bind on 127.0.0.1
//   FAKE_STARTUP_DELAY_MS  default 0: wait this long before the
//                          attach-check-then-bind decision, so a test can let
//                          another process win the port first
//   FAKE_HEALTH_DELAY_MS   default 0: once bound, /api/health answers
//                          unhealthy (503) for this long before flipping
//                          healthy, so a live pid file can exist before the
//                          server is actually ready to serve
import { createServer } from "node:http";
import { writePidFile } from "@brevi/orchestrator/pid";

const port = Number(process.env.FAKE_PORT);
const startupDelayMs = Number(process.env.FAKE_STARTUP_DELAY_MS ?? "0");
const healthDelayMs = Number(process.env.FAKE_HEALTH_DELAY_MS ?? "0");
const url = `http://127.0.0.1:${port}`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function alreadyHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(500) });
    if (!res.ok) return false;
    const body = (await res.json()) as Record<string, unknown>;
    return body.ok === true && typeof body.version === "string" && typeof body.sandboxProvider === "string";
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  if (startupDelayMs > 0) await sleep(startupDelayMs);

  if (await alreadyHealthy()) {
    process.exit(0);
  }

  const startedAt = Date.now();
  writePidFile({ owner: "cli", supervisorPid: null });

  const server = createServer((req, res) => {
    if (req.url === "/api/health") {
      if (Date.now() - startedAt < healthDelayMs) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: "0.0.0-fake", sandboxProvider: "process" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(port, "127.0.0.1");

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(() => process.exit(0));
    // In case a keep-alive socket holds close() open indefinitely.
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

void main();
