/** Shell-quoting + script builder for interactive resume sessions. */

const VALID_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Quotes a value for safe interpolation into a POSIX shell command. */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface BuildResumeScriptOptions {
  workspacePath: string;
  env: Record<string, string>;
  command: string;
  sessionId: string;
}

/**
 * Builds the POSIX sh script `brevi attach` runs inside a rehydrated sandbox
 * to reattach the agent conversation. Credentials are written into this
 * script on the sandbox's own filesystem rather than returned over the HTTP
 * response, so they never transit the dashboard/API layer a second time.
 */
export function buildResumeScript(options: BuildResumeScriptOptions): string {
  const { workspacePath, env, command, sessionId } = options;
  const lines = ["#!/bin/sh", `cd ${quote(workspacePath)}`];
  for (const [name, value] of Object.entries(env)) {
    if (!VALID_ENV_NAME.test(name)) continue;
    lines.push(`export ${name}=${quote(value)}`);
  }
  lines.push(`exec ${quote(command)} --resume ${quote(sessionId)}`);
  return `${lines.join("\n")}\n`;
}
