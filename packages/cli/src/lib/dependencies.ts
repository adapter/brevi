import { execFile, spawn } from "node:child_process";
import { collectFirecrackerProblems, resolveBinary } from "@brevi/sandbox";
import type { BreviConfig } from "@brevi/shared";
import { confirm, log, note } from "@clack/prompts";
import pc from "picocolors";
import { detectInstallMethod } from "./update.js";
import { errorMessage, exitOnCancel } from "./util.js";
import { readPackageVersion } from "./version.js";

/**
 * Result of probing a tool. Only "ok" counts as usable: an executable that is on PATH but
 * fails its --version probe (stale shim, broken install) would still fail at run time, so
 * it is treated like a missing tool and gets the same install offer.
 */
type Detection =
  | { state: "ok"; path: string; version: string }
  | { state: "unusable"; path: string }
  | { state: "missing" };

/** A ready-to-run install command, plus a hint appended to the confirm prompt (e.g. sudo). */
interface Installer {
  confirmHint: string;
  run: () => Promise<boolean>;
}

interface ToolDef {
  /** Binary name, used for PATH resolution and as the status column label. */
  name: string;
  /** Human-readable name used in prompts and log lines. */
  title: string;
  /** Explains why the tool matters; reused in the confirm prompt and the final status line. */
  note: (required: boolean) => string;
  /** Figures out how to install the tool on this host, or undefined if there is no strategy. */
  resolveInstaller: (required: boolean) => Promise<Installer | undefined>;
}

interface ToolResult {
  name: string;
  line: string;
  required: boolean;
  ok: boolean;
}

/**
 * Detects the external CLIs brevi shells out to (claude, codex, gh, wrangler), offers to
 * install any that are missing, and prints a per-tool status. Never throws and never sets
 * a nonzero exit code: a missing optional tool, a declined install, or a failed install all
 * just get reported. When every tool is already present this is quiet and fast (no prompts).
 */
export async function checkCliDependencies(saved: BreviConfig): Promise<void> {
  const agentsRequired = await agentsHostRequired(saved);
  const tools: Array<{ def: ToolDef; required: boolean }> = [
    { def: claudeTool, required: agentsRequired },
    { def: codexTool, required: agentsRequired },
    { def: ghTool, required: false },
    { def: wranglerTool, required: false },
  ];

  const results: ToolResult[] = [];
  for (const { def, required } of tools) {
    results.push(await checkTool(def, required));
  }

  const width = Math.max(...results.map((result) => result.name.length)) + 2;
  note(
    results.map((result) => `${result.name.padEnd(width)}${result.line}`).join("\n"),
    "CLI dependencies",
  );

  const missingRequired = results.filter((result) => result.required && !result.ok);
  if (missingRequired.length > 0) {
    log.warn(
      `Runs on the process provider will fail until ${missingRequired.map((result) => result.name).join(", ")} ${missingRequired.length === 1 ? "is" : "are"} installed. Re-run ${pc.cyan("brevi init")} to check again.`,
    );
  }
}

/** Whether the host itself needs the agent CLIs on PATH, i.e. the process provider is in play. */
async function agentsHostRequired(saved: BreviConfig): Promise<boolean> {
  const provider = saved.sandbox.provider;
  if (provider === "process") return true;
  if (provider === "firecracker") return false;
  // "auto": firecracker on a passing Linux host, process provider otherwise.
  if (process.platform !== "linux") return true;
  return (await collectFirecrackerProblems(saved.sandbox.firecracker, readPackageVersion())).length > 0;
}

async function checkTool(def: ToolDef, required: boolean): Promise<ToolResult> {
  const detection = await detect(def.name);
  if (detection.state === "ok") {
    return { name: def.name, line: `found (${detection.version})`, required, ok: true };
  }

  const requirementNote = def.note(required);
  const failLine = `${detection.state === "unusable" ? "unusable" : "missing"}: ${requirementNote}`;
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    return { name: def.name, line: failLine, required, ok: false };
  }

  const installer = await def.resolveInstaller(required);
  if (installer === undefined) {
    return { name: def.name, line: failLine, required, ok: false };
  }

  const explain = required ? log.warn : log.info;
  explain(
    detection.state === "unusable"
      ? `${def.title}: ${pc.dim(detection.path)} is on PATH but failed its --version probe, so runs can't rely on it. ${requirementNote}`
      : `${def.title}: ${requirementNote}`,
  );
  const install = exitOnCancel(
    await confirm({
      message: `${detection.state === "unusable" ? "Reinstall" : "Install"} ${def.title} now?${installer.confirmHint}`,
      initialValue: required,
    }),
  );
  if (!install) {
    return { name: def.name, line: `skipped: ${requirementNote}`, required, ok: false };
  }

  const success = await installer.run();
  if (!success) {
    return { name: def.name, line: failLine, required, ok: false };
  }

  const redetected = await detect(def.name);
  if (redetected.state !== "ok") {
    log.error(
      redetected.state === "missing"
        ? `${def.title} still isn't on PATH after the install.`
        : `${def.title} at ${redetected.path} still fails its --version probe after the install.`,
    );
    return { name: def.name, line: failLine, required, ok: false };
  }
  return {
    name: def.name,
    line: `installed now (${redetected.version})`,
    required,
    ok: true,
  };
}

async function detect(name: string): Promise<Detection> {
  const path = await resolveBinary(name);
  if (path === undefined) return { state: "missing" };
  const version = await toolVersion(path);
  return version === undefined ? { state: "unusable", path } : { state: "ok", path, version };
}

/**
 * wrangler is slow to start, hence the generous timeout. Requires a zero exit and a nonempty
 * version line (some tools print it to stderr); anything else means the binary is unusable.
 */
function toolVersion(path: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(path, ["--version"], { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) {
        resolve(undefined);
        return;
      }
      const output = stdout.trim() !== "" ? stdout : stderr;
      const first = output.split("\n", 1)[0]?.trim();
      resolve(first ? first : undefined);
    });
  });
}

/** Prints the exact command line, then runs it with inherited stdio so prompts (e.g. sudo) work. */
function runInstallCommand(command: string, args: string[]): Promise<boolean> {
  log.step(`Running ${pc.cyan([command, ...args].join(" "))}`);
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", (err) => {
      log.error(`Could not run ${command}: ${errorMessage(err)}`);
      resolve(false);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(true);
        return;
      }
      log.error(`${[command, ...args].join(" ")} exited with code ${code}.`);
      resolve(false);
    });
  });
}

/**
 * The package manager brevi itself was installed or run with, so tools land in the same global
 * prefix. The install path (detectInstallMethod) is authoritative: a bun global install runs
 * under node (the bin has a node shebang), so runtime markers alone would wrongly pick npm.
 * Markers are only the fallback for unknown installs, e.g. a repo checkout.
 */
function preferredPackageManager(): "bun" | "npm" {
  const method = detectInstallMethod();
  if (method.kind === "global" && (method.manager === "bun" || method.manager === "npm")) {
    return method.manager;
  }
  if (method.kind === "runner" && method.runner !== "pnpm dlx") {
    return method.runner === "bunx" ? "bun" : "npm";
  }
  const userAgent = process.env.npm_config_user_agent;
  if (userAgent?.startsWith("bun/")) return "bun";
  if (userAgent?.startsWith("npm/")) return "npm";
  if (process.versions.bun) return "bun";
  return "npm";
}

async function choosePackageManager(): Promise<"bun" | "npm" | undefined> {
  const preferred = preferredPackageManager();
  if ((await resolveBinary(preferred)) !== undefined) return preferred;
  const fallback = preferred === "bun" ? "npm" : "bun";
  if ((await resolveBinary(fallback)) !== undefined) return fallback;
  return undefined;
}

function npmGlobalInstaller(pkg: string): (required: boolean) => Promise<Installer | undefined> {
  return async () => {
    const manager = await choosePackageManager();
    if (manager === undefined) {
      log.warn(
        `No package manager found on PATH; install it manually: ${pc.cyan(`npm install -g ${pkg}`)}`,
      );
      return undefined;
    }
    const args = manager === "bun" ? ["add", "-g", pkg] : ["install", "-g", pkg];
    return { confirmHint: "", run: () => runInstallCommand(manager, args) };
  };
}

const AGENT_CLI_NOTE = (name: string) => (required: boolean) =>
  required
    ? "required: the process sandbox provider runs the agent CLI directly on the host"
    : `optional: the firecracker sandbox image already bundles ${name}`;

const claudeTool: ToolDef = {
  name: "claude",
  title: "Claude Code",
  note: AGENT_CLI_NOTE("Claude Code"),
  resolveInstaller: npmGlobalInstaller("@anthropic-ai/claude-code"),
};

const codexTool: ToolDef = {
  name: "codex",
  title: "Codex",
  note: AGENT_CLI_NOTE("Codex"),
  resolveInstaller: npmGlobalInstaller("@openai/codex"),
};

const GH_INSTALL_URL = "https://github.com/cli/cli#installation";

const ghTool: ToolDef = {
  name: "gh",
  title: "GitHub CLI",
  note: () => "optional, used by the Connect flow for GitHub credential discovery",
  resolveInstaller: async () => {
    if (process.platform === "darwin") {
      if ((await resolveBinary("brew")) !== undefined) {
        return { confirmHint: "", run: () => runInstallCommand("brew", ["install", "gh"]) };
      }
      log.warn(`Install it from ${pc.cyan(GH_INSTALL_URL)}.`);
      return undefined;
    }
    if (process.platform === "linux") {
      const managers: Array<{ bin: string; args: string[] }> = [
        { bin: "apt-get", args: ["install", "-y", "gh"] },
        { bin: "dnf", args: ["install", "-y", "gh"] },
        { bin: "pacman", args: ["-S", "--noconfirm", "github-cli"] },
        { bin: "zypper", args: ["install", "-y", "gh"] },
        { bin: "apk", args: ["add", "github-cli"] },
      ];
      for (const manager of managers) {
        if ((await resolveBinary(manager.bin)) === undefined) continue;
        const useSudo = process.getuid?.() !== 0;
        const command = useSudo ? "sudo" : manager.bin;
        const args = useSudo ? [manager.bin, ...manager.args] : manager.args;
        return {
          confirmHint: useSudo ? " (uses sudo)" : "",
          run: () => runInstallCommand(command, args),
        };
      }
    }
    log.warn(`Install it from ${pc.cyan(GH_INSTALL_URL)}.`);
    return undefined;
  },
};

const wranglerTool: ToolDef = {
  name: "wrangler",
  title: "Wrangler",
  note: () => "optional, used by the R2 connector for login, bucket provisioning, and uploads",
  resolveInstaller: npmGlobalInstaller("wrangler"),
};
