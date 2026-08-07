import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import {
  agentProvider,
  checkBucketAccessible,
  checkWrangler,
  discoverAnthropicCredential,
  discoverCodexCredential,
  PROCESS_PLAYWRIGHT_CACHE_DIR,
  validateLinearApiKey,
} from "@brevi/orchestrator";
import {
  collectFirecrackerPreflightProblems,
  fileExists,
  isReadWritable,
  resolveBinary,
} from "@brevi/sandbox";
import {
  BREVI_HOME,
  CONFIG_PATH,
  configSchema,
  urlHost,
  type BreviConfig,
  type HealthResponse,
  isHealthResponse,
} from "@brevi/shared";
import { confirm, isCancel } from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { buildEvidenceBundle } from "../lib/evidence.js";
import { inspectPidFile, pidListeningOnPort, type PidFileState } from "../lib/pid.js";
import { errorMessage, formatZodIssues, isZodLikeError } from "../lib/util.js";
import { readPackageVersion } from "../lib/version.js";

const execFileAsync = promisify(execFile);

type CheckStatus = "pass" | "warn" | "fail" | "skip";

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

interface Section {
  title: string;
  checks: CheckResult[];
}

const CLAUDE_DIAGNOSIS_MODEL = "claude-sonnet-5";
const CLAUDE_DIAGNOSIS_TIMEOUT_MS = 180_000;

const DIAGNOSIS_PROMPT =
  "You are diagnosing a broken local setup of brevi, a tool that watches Linear tickets, runs coding agents in local sandboxes, and opens GitHub PRs. Below is the JSON output of `brevi doctor`: per-check results (pass/warn/fail/skip), the user's config with secrets masked, the tail of the orchestrator's log, and the tail of the most recent run's event log when one exists. Work only from this evidence; do not use tools or read files. Reply with: 1) the most likely root cause of the failed checks, in one or two sentences; 2) concrete fix steps in order, with exact commands where possible. Be concise.";

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check the whole brevi setup: config, server, sandbox, connectors, and CLIs")
    .option("--ai", "on failures, run the Claude-powered diagnosis without asking")
    .action(async (options: { ai?: boolean }) => {
      await runDoctor(Boolean(options.ai));
    });
}

async function runDoctor(forceAi: boolean): Promise<void> {
  const { section: configSection, config: parsedConfig } = await checkConfigSection();
  const effectiveConfig = parsedConfig ?? configSchema.parse({});

  const [serverSection, sandboxSection, connectorsSection, cliSection] = await Promise.all([
    checkServerSection(effectiveConfig),
    checkSandboxSection(effectiveConfig),
    checkConnectorsSection(parsedConfig),
    checkExternalClisSection(),
  ]);

  const sections = [configSection, serverSection, sandboxSection, connectorsSection, cliSection];
  printSections(sections);

  const { passed, warned, failed } = summarize(sections);
  const parts = [`${passed} passed`];
  if (warned > 0) parts.push(`${warned} warning${warned === 1 ? "" : "s"}`);
  if (failed > 0) parts.push(`${failed} failed`);
  console.log();
  const summaryLine = pc.bold(parts.join(", "));
  console.log(failed > 0 ? pc.red(summaryLine) : warned > 0 ? pc.yellow(summaryLine) : pc.green(summaryLine));

  if (failed > 0) {
    process.exitCode = 1;
    await runAiDiagnosis(sections, parsedConfig, forceAi);
  }

  process.exit(process.exitCode ?? 0);
}

// --- Printing -----------------------------------------------------------------

function printSections(sections: Section[]): void {
  const width = Math.max(12, ...sections.flatMap((section) => section.checks.map((check) => check.name.length)));
  for (const section of sections) {
    console.log(pc.bold(section.title));
    for (const check of section.checks) {
      console.log(formatCheckLine(check, width));
      if (check.hint) console.log(formatHintLine(check.hint, width));
    }
  }
}

function symbolFor(status: CheckStatus): string {
  switch (status) {
    case "pass":
      return pc.green("✔");
    case "warn":
      return pc.yellow("!");
    case "fail":
      return pc.red("✖");
    case "skip":
      return pc.dim("·");
  }
}

function formatCheckLine(check: CheckResult, width: number): string {
  return `  ${symbolFor(check.status)} ${check.name.padEnd(width)} ${check.detail}`;
}

function formatHintLine(hint: string, width: number): string {
  const indent = " ".repeat(4 + width + 1);
  return pc.dim(`${indent}↳ ${hint}`);
}

function summarize(sections: Section[]): { passed: number; warned: number; failed: number } {
  let passed = 0;
  let warned = 0;
  let failed = 0;
  for (const section of sections) {
    for (const check of section.checks) {
      if (check.status === "pass") passed++;
      else if (check.status === "warn") warned++;
      else if (check.status === "fail") failed++;
    }
  }
  return { passed, warned, failed };
}

/** Resolves undefined instead of the promise's value when `ms` elapses first, and never rejects. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// --- Config ---------------------------------------------------------------------

async function checkConfigSection(): Promise<{ section: Section; config: BreviConfig | undefined }> {
  const checks: CheckResult[] = [];
  const finish = (config: BreviConfig | undefined): { section: Section; config: BreviConfig | undefined } => ({
    section: { title: "Config", checks },
    config,
  });

  let raw: string;
  try {
    raw = await readFile(CONFIG_PATH, "utf8");
  } catch {
    checks.push({
      name: "config file",
      status: "fail",
      detail: `no config at ${CONFIG_PATH}`,
      hint: "Run `brevi init` to create one.",
    });
    return finish(undefined);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    checks.push({
      name: "config file",
      status: "fail",
      detail: `not valid JSON: ${errorMessage(err)}`,
      hint: "Fix the file or recreate it with `brevi init`.",
    });
    return finish(undefined);
  }

  let config: BreviConfig;
  try {
    config = configSchema.parse(json);
  } catch (err) {
    const issues = isZodLikeError(err) ? formatZodIssues(err).join("; ") : errorMessage(err);
    checks.push({
      name: "config file",
      status: "fail",
      detail: truncate(issues, 500),
      hint: `Fix these fields in ${CONFIG_PATH}.`,
    });
    return finish(undefined);
  }

  checks.push({
    name: "config file",
    status: "pass",
    detail: `${CONFIG_PATH} parses and passes the schema`,
  });

  const unknownPaths = findUnknownKeys(json, config);
  if (unknownPaths.length > 0) {
    checks.push({
      name: "unknown keys",
      status: "warn",
      detail: `ignored by brevi: ${unknownPaths.join(", ")}`,
      hint: `Remove them from ${CONFIG_PATH}; they may be typos or leftovers from an older version.`,
    });
  }

  return finish(config);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Dotted paths present in `raw` but absent from `parsed`; zod silently drops unknown keys. */
function findUnknownKeys(raw: unknown, parsed: unknown, prefix = ""): string[] {
  if (!isPlainObject(raw) || !isPlainObject(parsed)) return [];
  const paths: string[] = [];
  for (const key of Object.keys(raw)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in parsed)) {
      paths.push(path);
      continue;
    }
    paths.push(...findUnknownKeys(raw[key], parsed[key], path));
  }
  return paths;
}

// --- Server -----------------------------------------------------------------------

const HEALTH_TIMEOUT_MS = 2000;

async function checkServerSection(config: BreviConfig): Promise<Section> {
  const port = config.server.port;
  // Probe the address the server actually binds to (server.host), not a
  // hardcoded localhost: a server bound to a LAN address does not necessarily
  // listen on loopback.
  const url = `http://${urlHost(config.server.host)}:${port}/api/health`;
  const pidState = inspectPidFile();

  let health: HealthResponse | undefined;
  let httpResponded = false;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    httpResponded = true;
    const body: unknown = await res.json().catch(() => undefined);
    if (isHealthResponse(body)) health = body;
  } catch {
    // Fetch failed outright: connection refused, reset, timed out, or DNS. Handled below.
  }

  const checks: CheckResult[] = [];

  if (health?.ok) {
    checks.push({
      name: "server",
      status: "pass",
      detail: `running on port ${port} (version ${health.version}, sandbox provider ${health.sandboxProvider})`,
    });
    checks.push(await reconcilePidFile(pidState, port));
    const cliVersion = readPackageVersion();
    if (health.version === cliVersion) {
      checks.push({
        name: "server version",
        status: "pass",
        detail: `server ${health.version} matches the installed CLI`,
      });
    } else {
      checks.push({
        name: "server version",
        status: "warn",
        detail: `server is ${health.version} but the installed CLI is ${cliVersion}`,
        hint: "Restart it (`brevi stop`, then `brevi start`) to pick up the update.",
      });
    }
    return { title: "Server", checks };
  }

  if (health) {
    // Shape-valid response with ok: false: the server answered but reports itself unhealthy.
    checks.push({
      name: "server",
      status: "fail",
      detail: `the server on port ${port} responded but reports unhealthy (version ${health.version})`,
      hint: "Check its console output, then `brevi stop` and start it again.",
    });
    return { title: "Server", checks };
  }

  // No valid brevi health response. Find out who, if anyone, holds the port:
  // a listener that resets or hangs the connection makes fetch reject just
  // like a free port would, and must not be misread as "not running".
  const listeningPid = await pidListeningOnPort(port);

  if (httpResponded) {
    checks.push({
      name: "server",
      status: "fail",
      detail: `port ${port} is in use by something that is not brevi${listeningPid !== null ? ` (pid ${listeningPid})` : ""}`,
      hint: `Stop that process or change server.port in ${CONFIG_PATH}.`,
    });
    return { title: "Server", checks };
  }

  if (pidState.state === "alive") {
    if (listeningPid !== null && listeningPid !== pidState.pid) {
      checks.push({
        name: "server",
        status: "fail",
        detail: `port ${port} is in use by something that is not brevi (pid ${listeningPid})`,
        hint: `Stop that process or change server.port in ${CONFIG_PATH}.`,
      });
    } else {
      checks.push({
        name: "server",
        status: "fail",
        detail: `process ${pidState.pid} is running but /api/health did not answer on port ${port}`,
        hint: "It may be starting up or wedged; check the terminal it runs in, or `brevi stop` and start it again.",
      });
    }
    return { title: "Server", checks };
  }

  if (listeningPid !== null) {
    checks.push({
      name: "server",
      status: "fail",
      detail: `not running, but port ${port} is in use by something that is not brevi (pid ${listeningPid})`,
      hint: `Stop that process or change server.port in ${CONFIG_PATH}; \`brevi start\` cannot bind until then.`,
    });
    return { title: "Server", checks };
  }

  if (pidState.state === "stale") {
    checks.push({
      name: "server",
      status: "fail",
      detail: `not running (stale pid file: pid ${pidState.pid} is gone)`,
      hint: "Start it with `brevi start`; the stale pid file is cleaned up automatically.",
    });
    return { title: "Server", checks };
  }

  if (pidState.state === "invalid") {
    checks.push({
      name: "server",
      status: "fail",
      detail: "not running (the pid file exists but is unreadable)",
      hint: "Start it with `brevi start`; the pid file is rewritten on startup.",
    });
    return { title: "Server", checks };
  }

  checks.push({
    name: "server",
    status: "fail",
    detail: "not running",
    hint: "Start it with `brevi start` (or `npx @brevi/cli`).",
  });
  return { title: "Server", checks };
}

/**
 * Pid file versus the server that just answered health: a healthy server with
 * an absent, invalid, stale, or mismatched pid file means `brevi stop` will
 * not find it by pid.
 */
async function reconcilePidFile(pidState: PidFileState, port: number): Promise<CheckResult> {
  if (pidState.state === "alive") {
    const listeningPid = await pidListeningOnPort(port);
    if (listeningPid !== null && listeningPid !== pidState.pid) {
      return {
        name: "pid file",
        status: "warn",
        detail: `records pid ${pidState.pid}, but the listener on port ${port} is pid ${listeningPid}`,
        hint: "Two brevi instances, or a copy started by hand? `brevi stop` would signal the recorded pid, not the server that answered.",
      };
    }
    return { name: "pid file", status: "pass", detail: `pid ${pidState.pid} matches the running server` };
  }
  const description =
    pidState.state === "absent"
      ? "no pid file"
      : pidState.state === "invalid"
        ? "the pid file is unreadable"
        : `the pid file is stale (pid ${pidState.pid} is gone)`;
  return {
    name: "pid file",
    status: "warn",
    detail: `the server is running but ${description}`,
    hint: "`brevi stop` falls back to the port listener; restarting (`brevi stop`, then `brevi start`) rewrites the pid file.",
  };
}

// --- Sandbox ----------------------------------------------------------------------

async function checkSandboxSection(config: BreviConfig): Promise<Section> {
  const checks: CheckResult[] = [];
  const provider = config.sandbox.provider;
  const runFirecracker = provider === "firecracker" || (provider === "auto" && process.platform === "linux");
  let runProcess = provider === "process" || (provider === "auto" && process.platform !== "linux");

  if (runFirecracker) {
    // The same complete preflight provider selection uses: kvm, binary,
    // kernel, rootfs (present, non-empty, with a current build manifest),
    // ssh key, tap devices, and IPv4 forwarding.
    const problems = await collectFirecrackerPreflightProblems(
      config.sandbox.firecracker,
      config.sandbox.concurrency,
    );
    if (problems.length === 0) {
      checks.push({
        name: "firecracker",
        status: "pass",
        detail: "ready (kvm, binary, kernel, rootfs, ssh key, network)",
      });
    } else if (provider === "firecracker") {
      checks.push({
        name: "firecracker",
        status: "fail",
        detail: problems.join("; "),
        hint: "Run `brevi setup` to provision this host.",
      });
    } else {
      checks.push({
        name: "firecracker",
        status: "warn",
        detail: `auto will fall back to the process provider (no isolation): ${problems.join("; ")}`,
        hint: "Run `brevi setup` for isolated runs.",
      });
      runProcess = true;
    }
  }

  if (runProcess) {
    checks.push(...(await checkProcessProvider(config)));
  }

  return { title: "Sandbox", checks };
}

async function checkProcessProvider(config: BreviConfig): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  const command = config.agent.command;
  const resolved = await resolveBinary(command);
  if (resolved !== undefined) {
    checks.push({ name: "agent CLI", status: "pass", detail: `${command} at ${resolved}` });
  } else {
    const hint =
      command === "claude"
        ? "Install Claude Code: npm install -g @anthropic-ai/claude-code"
        : command === "codex"
          ? "Install Codex: npm install -g @openai/codex"
          : "Install it or change agent.command.";
    checks.push({
      name: "agent CLI",
      status: "fail",
      detail: `"${command}" not found on PATH (the process provider runs the agent directly on this host)`,
      hint,
    });
  }

  if (await fileExists(BREVI_HOME)) {
    if (await isReadWritable(BREVI_HOME)) {
      checks.push({ name: "state dir", status: "pass", detail: `${BREVI_HOME} is writable` });
    } else {
      checks.push({
        name: "state dir",
        status: "fail",
        detail: `${BREVI_HOME} is not writable`,
        hint: "Fix its permissions; brevi keeps all run state there.",
      });
    }
  } else {
    checks.push({
      name: "state dir",
      status: "warn",
      detail: `${BREVI_HOME} does not exist yet`,
      hint: "It is created on first start.",
    });
  }

  checks.push(await checkPlaywrightCache());

  return checks;
}

/**
 * Read-only probe of the Playwright cache the process provider actually uses:
 * runs install browsers into this exact directory, and an existing cache can
 * be read-only even while ~/.brevi itself is writable.
 */
async function checkPlaywrightCache(): Promise<CheckResult> {
  const dir = PROCESS_PLAYWRIGHT_CACHE_DIR;
  if (await fileExists(dir)) {
    if (await isReadWritable(dir)) {
      return { name: "browser cache", status: "pass", detail: `${dir} is writable` };
    }
    return {
      name: "browser cache",
      status: "fail",
      detail: `${dir} exists but is not writable`,
      hint: "Fix its permissions; Playwright installs browsers there for demo capture.",
    };
  }
  const ancestor = await nearestExistingAncestor(dir);
  if (ancestor === undefined || (await isReadWritable(ancestor))) {
    return { name: "browser cache", status: "pass", detail: `${dir} will be created on first use` };
  }
  return {
    name: "browser cache",
    status: "fail",
    detail: `cannot create ${dir}: ${ancestor} is not writable`,
    hint: "Fix its permissions; Playwright installs browsers there for demo capture.",
  };
}

async function nearestExistingAncestor(path: string): Promise<string | undefined> {
  let current = dirname(path);
  while (true) {
    if (await fileExists(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

// --- Connectors -------------------------------------------------------------------

const CONNECTOR_NAMES = ["Linear", "GitHub", "Claude credential", "Codex credential", "R2"];

async function checkConnectorsSection(config: BreviConfig | undefined): Promise<Section> {
  if (!config) {
    return {
      title: "Connectors",
      checks: CONNECTOR_NAMES.map((name) => ({ name, status: "skip" as const, detail: "no config" })),
    };
  }

  const checks = await Promise.all([
    checkLinear(config),
    checkGithub(config),
    checkClaudeCredential(config),
    checkCodexCredential(config),
    checkR2(config),
  ]);

  return { title: "Connectors", checks };
}

const LINEAR_TIMEOUT_MS = 5000;

async function checkLinear(config: BreviConfig): Promise<CheckResult> {
  const key = config.linear.apiKey;
  if (!key) {
    return {
      name: "Linear",
      status: "fail",
      detail: "not connected",
      hint: "Connect Linear from the dashboard (Configuration, Connectors).",
    };
  }
  const result = await withTimeout(validateLinearApiKey(key), LINEAR_TIMEOUT_MS);
  if (result === undefined) {
    return { name: "Linear", status: "warn", detail: "could not verify within 5s (network?)" };
  }
  if (result.ok) return { name: "Linear", status: "pass", detail: result.detail };
  if (result.detail.startsWith("could not reach the provider")) {
    return { name: "Linear", status: "warn", detail: result.detail };
  }
  return {
    name: "Linear",
    status: "fail",
    detail: result.detail,
    hint: "The token may be expired or revoked; reconnect Linear from the dashboard.",
  };
}

const GITHUB_TIMEOUT_MS = 5000;

const GITHUB_HEADERS = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "brevi",
});

async function checkGithub(config: BreviConfig): Promise<CheckResult> {
  const token = config.github.token;
  if (!token) {
    return {
      name: "GitHub",
      status: "fail",
      detail: "not connected",
      hint: "Connect GitHub from the dashboard (Configuration, Connectors).",
    };
  }

  let login = "unknown user";
  let scopes: string[] | undefined;
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: GITHUB_HEADERS(token),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (res.status === 401) {
      return {
        name: "GitHub",
        status: "fail",
        detail: "GitHub rejected this token",
        hint: "Reconnect GitHub from the dashboard.",
      };
    }
    if (!res.ok) {
      return { name: "GitHub", status: "warn", detail: `GitHub returned ${res.status}` };
    }
    const user = (await res.json()) as { login?: string };
    login = user.login ?? login;
    const header = (res.headers.get("x-oauth-scopes") ?? "").trim();
    if (header !== "") {
      scopes = header
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean);
    }
  } catch {
    return { name: "GitHub", status: "warn", detail: "could not reach api.github.com" };
  }

  if (scopes && !scopes.includes("repo")) {
    return {
      name: "GitHub",
      status: "fail",
      detail: `connected as ${login} but the token lacks the "repo" scope`,
      hint: "brevi needs repo to push branches and open PRs; reconnect with the repo scope.",
    };
  }

  // /user only proves identity. A fine-grained token (no scopes header) may
  // still see none of the configured repositories or lack write access, so
  // verify each one with a cheap read-only call.
  const remotes = [...new Set(Object.values(config.repos).map((repo) => repo.remote))];
  const { problems, unverified } = await checkRepoAccess(token, remotes);
  if (problems.length > 0) {
    return {
      name: "GitHub",
      status: "fail",
      detail: `connected as ${login}, but ${problems.join("; ")}`,
      hint: "Grant the token access to these repositories (fine-grained tokens need Contents and Pull requests read/write), or reconnect GitHub from the dashboard.",
    };
  }

  const tokenDescription = scopes ? `scopes: ${scopes.join(", ")}` : "fine-grained token, scopes not reported";
  if (unverified.length > 0) {
    return {
      name: "GitHub",
      status: "warn",
      detail: `connected as ${login} (${tokenDescription}); could not verify access to ${unverified.join(", ")}`,
    };
  }
  const repoSummary =
    remotes.length > 0
      ? `; write access to ${remotes.length} configured repo${remotes.length === 1 ? "" : "s"}`
      : scopes
        ? ""
        : "; no repositories configured to verify against";
  if (scopes && !scopes.includes("workflow")) {
    return {
      name: "GitHub",
      status: "warn",
      detail: `connected as ${login}; no "workflow" scope (pushes touching .github/workflows will be rejected)${repoSummary}`,
    };
  }
  return { name: "GitHub", status: "pass", detail: `connected as ${login} (${tokenDescription})${repoSummary}` };
}

/**
 * Push (write) access to each configured repository, via GET /repos/{owner}/{name}:
 * hard failures (invisible repo, missing push permission) versus repos that
 * could not be verified because the probe itself failed.
 */
async function checkRepoAccess(
  token: string,
  remotes: string[],
): Promise<{ problems: string[]; unverified: string[] }> {
  const problems: string[] = [];
  const unverified: string[] = [];
  await Promise.all(
    remotes.map(async (remote) => {
      try {
        const res = await fetch(`https://api.github.com/repos/${remote}`, {
          headers: GITHUB_HEADERS(token),
          signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
        });
        if (res.status === 404 || res.status === 403) {
          problems.push(`the token cannot see ${remote}`);
          return;
        }
        if (!res.ok) {
          unverified.push(remote);
          return;
        }
        const repo = (await res.json()) as { permissions?: { push?: boolean } };
        if (repo.permissions?.push !== true) {
          problems.push(`no push (write) access to ${remote}`);
        }
      } catch {
        unverified.push(remote);
      }
    }),
  );
  return { problems: problems.sort(), unverified: unverified.sort() };
}

/**
 * Runs consume only credentials saved in the config (collectAgentEnv); a
 * credential that is merely discoverable on the host would still leave the
 * next run failing with "no agent credentials configured", so discovery is
 * only ever mentioned in the failure detail, never counted as a pass.
 */
async function checkClaudeCredential(config: BreviConfig): Promise<CheckResult> {
  if (config.agent.anthropicApiKey) {
    return { name: "Claude credential", status: "pass", detail: "configured (agent.anthropicApiKey)" };
  }
  if (config.agent.claudeCodeOauthToken) {
    return { name: "Claude credential", status: "pass", detail: "configured (agent.claudeCodeOauthToken)" };
  }
  if (agentProvider(config) !== "claude") {
    return {
      name: "Claude credential",
      status: "skip",
      detail: `not needed (agent.command is "${config.agent.command}")`,
    };
  }
  const discovered = await discoverAnthropicCredential();
  return {
    name: "Claude credential",
    status: "fail",
    detail: discovered
      ? `found via ${discovered.source} on this host, but it is not saved in the config runs use`
      : "no Anthropic credential in the config",
    hint: "Connect Claude from the dashboard (Configuration, Connectors); connecting validates the credential and saves it for runs.",
  };
}

async function checkCodexCredential(config: BreviConfig): Promise<CheckResult> {
  if (config.agent.codexApiKey) {
    return { name: "Codex credential", status: "pass", detail: "configured (agent.codexApiKey)" };
  }
  if (config.agent.codexAuthJson) {
    return { name: "Codex credential", status: "pass", detail: "configured (agent.codexAuthJson)" };
  }
  if (agentProvider(config) === "codex") {
    const discovered = await discoverCodexCredential();
    return {
      name: "Codex credential",
      status: "fail",
      detail: discovered
        ? `found via ${discovered.source} on this host, but it is not saved in the config runs use`
        : "no Codex credential in the config",
      hint: "Connect Codex from the dashboard (Configuration, Connectors); connecting validates the credential and saves it for runs.",
    };
  }
  if (config.agent.codexReview) {
    const discovered = await discoverCodexCredential();
    return {
      name: "Codex credential",
      status: "warn",
      detail: discovered
        ? `found via ${discovered.source} on this host but not saved in the config, so the Codex review pass will be skipped`
        : "not configured; the Codex review pass will be skipped",
      hint: "Optional: connect a Codex credential from the dashboard to enable adversarial review.",
    };
  }
  return { name: "Codex credential", status: "skip", detail: "not needed" };
}

/** Shared deadline for both wrangler probes, which run in parallel below. */
const R2_TIMEOUT_MS = 10_000;

async function checkR2(config: BreviConfig): Promise<CheckResult> {
  const { bucket, publicBaseUrl } = config.r2;
  if (!bucket && !publicBaseUrl) {
    return { name: "R2", status: "skip", detail: "not configured (optional evidence uploads)" };
  }
  if (!bucket) {
    return {
      name: "R2",
      status: "fail",
      detail: "r2.publicBaseUrl is set but r2.bucket is empty",
      hint: `Set r2.bucket in ${CONFIG_PATH} or reconnect R2 from the dashboard.`,
    };
  }
  // Both wrangler subprocesses run concurrently under one deadline, so an
  // unresponsive Cloudflare path costs ~10s, not the sum of both maximums.
  const [auth, bucketResult] = await Promise.all([
    checkWrangler(R2_TIMEOUT_MS),
    checkBucketAccessible(bucket, R2_TIMEOUT_MS),
  ]);
  if (!auth.installed) {
    return {
      name: "R2",
      status: "fail",
      detail: "wrangler is not installed but r2 is configured",
      hint: "npm install -g wrangler, then wrangler login.",
    };
  }
  if (auth.timedOut) {
    return {
      name: "R2",
      status: "warn",
      detail: `wrangler did not answer within ${R2_TIMEOUT_MS / 1000}s`,
      hint: "Cloudflare may be slow or unreachable; uploads will be skipped until it answers. Retry later.",
    };
  }
  if (!auth.loggedIn) {
    return { name: "R2", status: "fail", detail: "wrangler is not logged in", hint: "Run `wrangler login`." };
  }
  if (bucketResult.ok) {
    return {
      name: "R2",
      status: "pass",
      detail: `logged in as ${auth.account ?? "unknown account"}; ${bucketResult.detail}`,
    };
  }
  if (bucketResult.timedOut) {
    return {
      name: "R2",
      status: "warn",
      detail: `logged in as ${auth.account ?? "unknown account"}; ${bucketResult.detail}`,
      hint: "Cloudflare may be slow or unreachable; retry later.",
    };
  }
  return {
    name: "R2",
    status: "fail",
    detail: bucketResult.detail,
    hint: `Check the bucket name in ${CONFIG_PATH} or recreate it from the dashboard.`,
  };
}

// --- External CLIs -----------------------------------------------------------------

const EXTERNAL_TOOLS = [
  { name: "claude", whyOptional: "runs agents with the process provider and powers `brevi doctor` AI diagnosis" },
  { name: "codex", whyOptional: "runs Codex agents and the review pass" },
  { name: "gh", whyOptional: "enables one-click GitHub connect" },
  { name: "wrangler", whyOptional: "needed for R2 evidence uploads" },
];

async function checkExternalClisSection(): Promise<Section> {
  const checks = await Promise.all(
    EXTERNAL_TOOLS.map(async ({ name, whyOptional }): Promise<CheckResult> => {
      const resolved = await resolveBinary(name);
      if (resolved === undefined) {
        return { name, status: "skip", detail: `not installed (${whyOptional})` };
      }
      const version = await firstVersionLine(resolved);
      return { name, status: "pass", detail: version || resolved };
    }),
  );
  return { title: "External CLIs", checks };
}

async function firstVersionLine(path: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(path, ["--version"], { timeout: 3000 });
    return stdout.split("\n", 1)[0]?.trim() ?? "";
  } catch {
    return "";
  }
}

// --- AI diagnosis -------------------------------------------------------------------

async function runAiDiagnosis(
  sections: Section[],
  config: BreviConfig | undefined,
  forceAi: boolean,
): Promise<void> {
  const claudePath = await resolveBinary("claude");
  if (claudePath === undefined) {
    console.log(pc.dim("Install the claude CLI to get an AI diagnosis of these failures (brevi doctor --ai)."));
    return;
  }

  let run = forceAi;
  if (!run) {
    if (process.stdout.isTTY && process.stdin.isTTY) {
      const answer = await confirm({
        message: "Run a Claude-powered diagnosis of the failed checks?",
        initialValue: true,
      });
      run = !isCancel(answer) && answer === true;
    } else {
      console.log(pc.dim("Run brevi doctor --ai for a Claude-powered diagnosis of these failures."));
      return;
    }
  }
  if (!run) return;

  const checks = sections.flatMap((section) =>
    section.checks.map((check) => ({
      section: section.title,
      name: check.name,
      status: check.status,
      detail: check.detail,
      hint: check.hint,
    })),
  );
  const bundle = await buildEvidenceBundle(checks, config);

  console.log();
  console.log(pc.bold("Claude diagnosis"));
  console.log(pc.dim(`(claude -p, model ${CLAUDE_DIAGNOSIS_MODEL}, read-only, all tools disabled)`));

  await runClaudeDiagnosis(claudePath, bundle);
}

/** Runs `claude -p` with the evidence bundle on stdin, printing its reply directly. */
function runClaudeDiagnosis(claudePath: string, bundle: string): Promise<void> {
  const prompt = `${DIAGNOSIS_PROMPT}\n\n${bundle}`;
  return new Promise((resolve) => {
    // The diagnosis works only from the evidence in the prompt: the entire
    // built-in tool set is disabled (--tools ""), and --safe-mode plus
    // --strict-mcp-config keep user and project customizations (plugins,
    // hooks, MCP servers) from adding tools back. The prompt's "do not use
    // tools" instruction is just defense in depth on top of that.
    const child = spawn(
      claudePath,
      ["-p", "--model", CLAUDE_DIAGNOSIS_MODEL, "--tools", "", "--safe-mode", "--strict-mcp-config"],
      { stdio: ["pipe", "inherit", "inherit"] },
    );
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      console.log(pc.dim("diagnosis timed out"));
      resolve();
    }, CLAUDE_DIAGNOSIS_TIMEOUT_MS);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      console.log(pc.dim(`could not run claude: ${errorMessage(err)}`));
      resolve();
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) console.log(pc.dim(`claude exited with code ${code}.`));
      resolve();
    });

    // Swallow stdin errors (EPIPE when claude exits before reading); the
    // close handler already reports the outcome.
    child.stdin?.on("error", () => {});
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}
