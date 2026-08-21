import { StringDecoder } from "node:string_decoder";
import { formatDuration } from "@brevi/shared";
import { execa, type Options } from "execa";
import type { ExecResult } from "./types.js";

/** Per-stream cap on captured output. Older output is dropped so the tail survives. */
const MAX_CAPTURED_CHARS = 2 * 1024 * 1024;

/** Exit code reported for a timed-out command, matching `timeout(1)`. */
const TIMEOUT_EXIT_CODE = 124;

/** Grace period between SIGTERM and SIGKILL when a command hits its timeout. */
const FORCE_KILL_DELAY_MS = 5_000;

export interface RunCommandOptions {
  /** Complete environment for the child. When omitted the host environment is inherited. */
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Terminates the child when aborted; the returned promise still resolves. */
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /**
   * Run the child as its own process-group leader (setpgid). Lets a caller
   * kill the whole group later, which the Seatbelt provider uses to reap
   * daemonized descendants it has no PID namespace to contain.
   */
  detached?: boolean;
  /** The child's pid, as soon as it is spawned. Paired with `detached` for group teardown. */
  onSpawn?: (pid: number) => void;
}

/**
 * Runs a command, streaming output to the callbacks while capturing the tail of each
 * stream. Never throws for a non-zero exit; failures are reported through `exitCode`.
 */
export async function runCommand(
  file: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<ExecResult> {
  const stdout = new OutputBuffer(options.onStdout);
  const stderr = new OutputBuffer(options.onStderr);

  const execaOptions: Options = {
    env: options.env,
    extendEnv: options.env === undefined,
    timeout: options.timeoutMs ?? 0,
    ...(options.signal ? { cancelSignal: options.signal } : {}),
    forceKillAfterDelay: FORCE_KILL_DELAY_MS,
    buffer: false,
    reject: false,
    ...(options.detached ? { detached: true } : {}),
    stdin: "ignore",
  };

  const subprocess = execa(file, args, execaOptions);
  const pid = subprocess.pid;
  if (typeof pid === "number") options.onSpawn?.(pid);
  // The detached child leads its own process group. When the foreground
  // process exits, sweep the group: a daemonized descendant is reaped
  // (Seatbelt has no PID namespace to do this) and its inherited stdout/
  // stderr pipes close, so `await subprocess` resolves instead of hanging on
  // a background process that outlived the command. execa's subprocess has no
  // exit event, so the leader's death is detected by polling.
  let groupSweep: ReturnType<typeof setInterval> | undefined;
  if (options.detached && typeof pid === "number") {
    groupSweep = setInterval(() => {
      try {
        process.kill(pid, 0);
      } catch {
        // Leader gone: reap the rest of its group.
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // Group already gone.
        }
      }
    }, 50);
    groupSweep.unref?.();
  }
  subprocess.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  subprocess.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  let result;
  try {
    result = await subprocess;
  } finally {
    if (groupSweep) clearInterval(groupSweep);
    if (options.detached && typeof pid === "number") {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Group already gone.
      }
    }
  }

  const note = failureNote(result, options.timeoutMs);
  if (note !== undefined) stderr.push(note);

  return {
    exitCode: exitCodeOf(result),
    timedOut: result.timedOut,
    stdout: stdout.finish(),
    stderr: stderr.finish(),
  };
}

interface CommandOutcome {
  failed: boolean;
  timedOut: boolean;
  isCanceled?: boolean;
  exitCode?: number | undefined;
}

function exitCodeOf(result: CommandOutcome): number {
  if (result.timedOut) return TIMEOUT_EXIT_CODE;
  if (typeof result.exitCode === "number") return result.exitCode;
  return result.failed ? 1 : 0;
}

/** Surfaces timeouts, cancellations, and spawn failures, which otherwise leave both streams empty. */
function failureNote(result: CommandOutcome, timeoutMs: number | undefined): string | undefined {
  if (result.timedOut) return `\nbrevi: command timed out after ${formatDuration(timeoutMs ?? 0)}\n`;
  if (result.isCanceled) return "\nbrevi: command cancelled\n";
  if (!result.failed || result.exitCode !== undefined) return undefined;
  return `\nbrevi: ${shortMessageOf(result) ?? "command failed to run"}\n`;
}

function shortMessageOf(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null || !("shortMessage" in result)) return undefined;
  const { shortMessage } = result;
  return typeof shortMessage === "string" ? shortMessage : undefined;
}

/** Decodes chunks to text, forwards them live, and retains at most the trailing cap. */
class OutputBuffer {
  readonly #decoder = new StringDecoder("utf8");
  readonly #onChunk: ((chunk: string) => void) | undefined;
  #chunks: string[] = [];
  #length = 0;

  constructor(onChunk?: (chunk: string) => void) {
    this.#onChunk = onChunk;
  }

  push(chunk: Buffer | string): void {
    const text = typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    if (text === "") return;
    this.#onChunk?.(text);
    this.#chunks.push(text);
    this.#length += text.length;
    this.#trim();
  }

  finish(): string {
    const tail = this.#decoder.end();
    if (tail !== "") this.push(tail);
    return this.#chunks.join("");
  }

  /** Drops whole chunks from the front, then trims the new front chunk to hit the cap exactly. */
  #trim(): void {
    while (this.#length > MAX_CAPTURED_CHARS) {
      const first = this.#chunks[0];
      if (first === undefined) return;
      if (this.#length - first.length >= MAX_CAPTURED_CHARS) {
        this.#chunks.shift();
        this.#length -= first.length;
        continue;
      }
      this.#chunks[0] = first.slice(this.#length - MAX_CAPTURED_CHARS);
      this.#length = MAX_CAPTURED_CHARS;
    }
  }
}
