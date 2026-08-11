import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { formatWithOptions } from "node:util";
import { LOGS_DIR, ORCHESTRATOR_LOG_PATH } from "@brevi/shared";

export { ORCHESTRATOR_LOG_PATH };

const MAX_LOG_BYTES = 1024 * 1024;
// eslint-disable-next-line no-control-regex -- stripping ANSI color codes is the point
const ANSI_RE = /\u001b\[[0-9;]*m/g;

let attached = false;

/** Strip picocolors' ANSI escape sequences so the log file stays plain text. */
function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function appendLine(level: string, args: unknown[]): void {
  try {
    const text = stripAnsi(formatWithOptions({ colors: false }, ...args));
    appendFileSync(ORCHESTRATOR_LOG_PATH, `${new Date().toISOString()} [${level}] ${text}\n`);
  } catch {
    // Best-effort: file logging must never break or slow the server.
  }
}

/**
 * Tee console output to `~/.brevi/logs/orchestrator.log`, so `brevi doctor`
 * has a log tail to bundle as diagnosis evidence. Idempotent, best-effort,
 * and silent on any failure: a broken log file must never break or slow the
 * server.
 */
export function attachOrchestratorLogFile(): void {
  if (attached) return;
  attached = true;
  try {
    mkdirSync(LOGS_DIR, { recursive: true });
    if (existsSync(ORCHESTRATOR_LOG_PATH) && statSync(ORCHESTRATOR_LOG_PATH).size > MAX_LOG_BYTES) {
      renameSync(ORCHESTRATOR_LOG_PATH, `${ORCHESTRATOR_LOG_PATH}.1`);
    }
  } catch {
    // Best-effort: if rotation fails, keep appending to the existing file.
  }

  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  console.log = (...args: unknown[]): void => {
    original.log(...args);
    appendLine("log", args);
  };
  console.info = (...args: unknown[]): void => {
    original.info(...args);
    appendLine("info", args);
  };
  console.warn = (...args: unknown[]): void => {
    original.warn(...args);
    appendLine("warn", args);
  };
  console.error = (...args: unknown[]): void => {
    original.error(...args);
    appendLine("error", args);
  };
}
