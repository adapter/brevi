/**
 * Shell-quoting plus the two POSIX sh fragments `brevi attach` installs
 * inside a rehydrated sandbox: a credential profile (sandbox-wide state, so
 * every shell is authenticated, not just the resumed conversation) and the
 * resume script that sources it before reattaching the agent conversation.
 */

const VALID_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Quotes a value for safe interpolation into a POSIX shell command. */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Variables the profile owns outright. Cleared before the configured state is
 * exported: an attach shell must not keep a stale host OPENAI_API_KEY (or a
 * credential disconnected since the sandbox was retained).
 */
const MANAGED_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "XAI_API_KEY",
  "CODEX_HOME",
  "GROK_HOME",
  "GIT_ASKPASS",
];

export interface BuildCredentialProfileOptions {
  env: Record<string, string>;
  /** Where the profile itself is installed; exported as ENV so interactive `sh` re-sources it. */
  profilePath: string;
  /** Stable directory holding Codex state (auth.json, rollout history), exported as CODEX_HOME. */
  codexHome: string;
  /** Stable directory holding Grok state (auth.json), exported as GROK_HOME. */
  grokHome: string;
  /** Git askpass helper carrying the connected GitHub token, exported as GIT_ASKPASS when set. */
  gitAskpassPath?: string;
}

/**
 * Builds the POSIX sh fragment installed as sandbox-wide credential state
 * (see provision.ts): sourced, not executed, so it carries no shebang.
 * Credentials are written here, onto the sandbox's own filesystem, rather
 * than returned over the HTTP response, so they never transit the
 * dashboard/API layer a second time.
 */
export function buildCredentialProfile(options: BuildCredentialProfileOptions): string {
  const { env, profilePath, codexHome, grokHome, gitAskpassPath } = options;
  const lines = [
    "# brevi agent credentials; reinstalled on every attach, removed with the sandbox",
    // Exact state: the configured credentials replace, never overlay,
    // whatever the sourcing shell inherited.
    `unset ${MANAGED_ENV_VARS.join(" ")}`,
  ];
  for (const [name, value] of Object.entries(env)) {
    if (!VALID_ENV_NAME.test(name)) continue;
    lines.push(`export ${name}=${quote(value)}`);
  }
  lines.push(`export CODEX_HOME=${quote(codexHome)}`);
  lines.push(`export GROK_HOME=${quote(grokHome)}`);
  if (gitAskpassPath) lines.push(`export GIT_ASKPASS=${quote(gitAskpassPath)}`);
  // POSIX sh sources $ENV for interactive shells, so a plain `sh` opened
  // beside the resumed conversation re-sources this profile (and a host ENV
  // pointing somewhere else can't leak into the attach session).
  lines.push(`export ENV=${quote(profilePath)}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Builds the git askpass helper installed beside the credential profile. The
 * checkout's origin is deliberately a credential-free https URL, so git asks
 * for a username and password; this answers with the connected GitHub token,
 * letting attached shells push without the token ever entering .git/config.
 */
export function buildGitAskpass(token: string): string {
  const lines = [
    "#!/bin/sh",
    "# brevi git credentials; reinstalled on every attach, removed with the sandbox",
    'case "$1" in',
    `  Username*) printf 'x-access-token\\n' ;;`,
    `  *) printf '%s\\n' ${quote(token)} ;;`,
    "esac",
  ];
  return `${lines.join("\n")}\n`;
}

export interface BuildResumeScriptOptions {
  workspacePath: string;
  /** Absolute path of the credential profile (see buildCredentialProfile) to source. */
  profilePath: string;
  command: string;
  sessionId: string;
}

/**
 * Builds the POSIX sh script `brevi attach` runs inside a rehydrated sandbox
 * to reattach the agent conversation. It sources the credential profile
 * rather than exporting credentials itself, so the resumed process picks up
 * the same sandbox-wide state any other shell in the sandbox gets. The
 * conversation runs as a plain foreground command, not an exec: when it
 * ends, the attach drops into an interactive shell that inherits the sourced
 * profile, so `claude --resume` (or anything else) can be run by hand, still
 * authenticated. The attach session, and with it the rehydrated sandbox,
 * lives until that shell exits.
 */
export function buildResumeScript(options: BuildResumeScriptOptions): string {
  const { workspacePath, profilePath, command, sessionId } = options;
  const lines = [
    "#!/bin/sh",
    `. ${quote(profilePath)}`,
    `export HOME=${quote(workspacePath)}`,
    "export TMPDIR=/tmp",
    `cd ${quote(workspacePath)}`,
    `${quote(command)} --resume ${quote(sessionId)}`,
    `printf '\\n[brevi] conversation ended; this shell stays authenticated. exit to detach.\\n'`,
    "exec /bin/sh -i",
  ];
  return `${lines.join("\n")}\n`;
}
