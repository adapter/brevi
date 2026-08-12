import { spawn } from "node:child_process";
import { resolveBinary } from "@brevi/sandbox";

/**
 * Thin wrappers over the `limactl` binary, plus one pure parser
 * (`parseLimaStatus`) that the tests exercise directly, off a Mac, without
 * spawning anything. Everything else here shells out and is only ever
 * exercised for real on macOS; `packages/cli/src/mac/install.ts` and
 * `packages/cli/src/mac/supervisor.ts` are the only callers.
 */

/** How Lima is installed on a Mac, for the installer's offer. */
export const LIMA_BREW_PACKAGE = "lima";

export type LimaVmStatus = "Running" | "Stopped" | "Broken" | "Missing";

const KNOWN_STATUSES = new Set<LimaVmStatus>(["Running", "Stopped", "Broken"]);

/** Absolute path to limactl, or undefined when Lima is not installed. */
export function findLimactl(): Promise<string | undefined> {
  return resolveBinary("limactl");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Parses `limactl list --json` output into the raw entries, tolerating both shapes and any garbage. */
function parseListEntries(listOutput: string): Array<Record<string, unknown>> {
  const trimmed = listOutput.trim();
  if (trimmed === "") return [];

  // `limactl list --json` normally prints one JSON object per line, but tolerate a
  // single JSON array too (e.g. hand-constructed test fixtures, or a future Lima
  // version) by trying a whole-output parse first.
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.filter(isRecord);
  } catch {
    // Not a single JSON value; fall through to line-by-line parsing.
  }

  const entries: Array<Record<string, unknown>> = [];
  for (const line of trimmed.split("\n")) {
    const candidate = line.trim();
    if (candidate === "") continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) entries.push(parsed);
    } catch {
      // Ignore malformed lines rather than throwing; the caller would rather
      // see "Missing" than crash on output it doesn't understand.
    }
  }
  return entries;
}

/** Parse `limactl list --json` (one JSON object per line) for one instance; "Missing" when it is not there. */
export function parseLimaStatus(listOutput: string, name: string): LimaVmStatus {
  const entries = parseListEntries(listOutput);
  const match = entries.find((entry) => entry.name === name);
  if (match === undefined) return "Missing";
  const status = typeof match.status === "string" ? match.status : "";
  return KNOWN_STATUSES.has(status as LimaVmStatus) ? (status as LimaVmStatus) : "Broken";
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawns `limactl <args>`, streaming both stdout and stderr line by line into
 * `onLine` while also capturing the full output for error messages. Never
 * rejects on a non-zero exit; callers decide what that means.
 */
function runLimactl(
  args: string[],
  options: { onLine?: (line: string) => void; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("limactl", args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer =
      options.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, options.timeoutMs)
        : undefined;

    const lineBuffers = { stdout: "", stderr: "" };
    const onChunk = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (stream === "stdout") stdout += text;
      else stderr += text;
      lineBuffers[stream] += text;
      let newlineIndex = lineBuffers[stream].indexOf("\n");
      while (newlineIndex !== -1) {
        const line = lineBuffers[stream].slice(0, newlineIndex);
        lineBuffers[stream] = lineBuffers[stream].slice(newlineIndex + 1);
        if (line !== "") options.onLine?.(line);
        newlineIndex = lineBuffers[stream].indexOf("\n");
      }
    };
    child.stdout?.on("data", onChunk("stdout"));
    child.stderr?.on("data", onChunk("stderr"));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(new Error(`limactl ${args[0] ?? ""} could not start: ${err.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ exitCode: timedOut ? 124 : (code ?? 1), stdout, stderr });
    });
  });
}

/** Last part of a stderr blob, for a throw message that stays readable when limactl is chatty. */
function stderrTail(stderr: string, maxChars = 2000): string {
  const trimmed = stderr.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `...${trimmed.slice(trimmed.length - maxChars)}`;
}

function failure(action: string, name: string, result: RunResult): Error {
  return new Error(`limactl ${action} ${name} failed (exit ${result.exitCode}): ${stderrTail(result.stderr)}`);
}

export async function limaStatus(name: string): Promise<LimaVmStatus> {
  const result = await runLimactl(["list", "--json"], { timeoutMs: 15_000 });
  if (result.exitCode !== 0) return "Missing";
  return parseLimaStatus(result.stdout, name);
}

/** Create and first-boot the instance from a rendered template, streaming provisioning output. */
export async function limaCreate(
  name: string,
  templatePath: string,
  onLine?: (line: string) => void,
): Promise<void> {
  // Creating and provisioning a fresh guest (pulling a multi-GB image, running
  // `brevi setup --yes`) takes minutes, so no timeout here; the caller can
  // still bound it externally if it ever needs to.
  const result = await runLimactl(["start", `--name=${name}`, "--tty=false", templatePath], { onLine });
  if (result.exitCode !== 0) throw failure("start (create)", name, result);
}

export async function limaStart(name: string, onLine?: (line: string) => void): Promise<void> {
  const result = await runLimactl(["start", "--tty=false", name], { onLine });
  if (result.exitCode !== 0) throw failure("start", name, result);
}

export async function limaStop(name: string): Promise<void> {
  const result = await runLimactl(["stop", name], { timeoutMs: 60_000 });
  if (result.exitCode !== 0) throw failure("stop", name, result);
}

export async function limaDelete(name: string): Promise<void> {
  const result = await runLimactl(["delete", "--force", name], { timeoutMs: 60_000 });
  if (result.exitCode !== 0) throw failure("delete", name, result);
}

/** Run a command inside the guest; never throws on a non-zero exit. */
export async function limaShell(
  name: string,
  command: string[],
  options: { onLine?: (line: string) => void; timeoutMs?: number } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    return await runLimactl(["shell", "--workdir", "/", name, ...command], {
      onLine: options.onLine,
      // Short by default (the callers that poll the guest want a probe, not a
      // wait), but overridable for the one caller that re-runs provisioning.
      timeoutMs: options.timeoutMs ?? 30_000,
    });
  } catch (err) {
    // runLimactl only rejects when the limactl process itself could not be
    // spawned; limaShell's contract is to never throw, so fold that into a
    // synthetic non-zero result instead.
    return { exitCode: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
}
