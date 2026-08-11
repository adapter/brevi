import { existsSync } from "node:fs";
import { loadConfig, saveConfig } from "@brevi/orchestrator";
import { collectFirecrackerProblems } from "@brevi/sandbox";
import { CONFIG_PATH, type BreviConfig } from "@brevi/shared";
import { confirm, intro, log, note, outro, select, spinner } from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { checkCliDependencies } from "../lib/dependencies.js";
import { errorMessage, exitOnCancel, formatZodIssues, isZodLikeError } from "../lib/util.js";
import { readPackageVersion } from "../lib/version.js";
import { runSetup } from "./setup.js";

type SandboxProvider = "auto" | "firecracker" | "process";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Create the brevi config and choose a sandbox provider")
    .action(async () => {
      try {
        await runInit();
      } catch (err) {
        log.error(errorMessage(err));
        process.exit(1);
      }
    });
}

export interface RunInitOptions {
  /**
   * Set when init runs automatically because `brevi` was launched without a
   * config. Adjusts the copy: explains why the prompt appeared and skips the
   * "run brevi" next steps, since the dashboard is about to open.
   */
  firstRun?: boolean;
}

/** Runs the init flow. Resolves to true when a config was saved. */
export async function runInit({ firstRun = false }: RunInitOptions = {}): Promise<boolean> {
  intro(pc.bgCyan(pc.black(firstRun ? " brevi " : " brevi init ")));

  if (firstRun) {
    log.info(`No config found at ${pc.dim(CONFIG_PATH)}, so running first-time setup.`);
  }

  const existing = await loadExisting();
  if (existsSync(CONFIG_PATH)) {
    const proceed = exitOnCancel(
      await confirm({
        message: existing
          ? `A config already exists at ${pc.dim(CONFIG_PATH)}. Update it?`
          : `A config exists at ${pc.dim(CONFIG_PATH)} but couldn't be parsed. Overwrite it?`,
        initialValue: true,
      }),
    );
    if (!proceed) {
      outro("Nothing changed.");
      return false;
    }
  }

  log.info(
    "Everything else is set up from the dashboard: connect Linear, GitHub, and agent keys in the Connections panel, then pick repositories straight from your GitHub account.",
  );

  const provider = await collectSandboxProvider(existing);

  // Preserve everything else from an existing config (credentials, repos, ...).
  const draft = { ...existing, sandbox: { ...existing?.sandbox, provider } };

  note(summarize(provider, existing), "Configuration summary");

  const confirmed = exitOnCancel(
    await confirm({ message: "Save this configuration?", initialValue: true }),
  );
  if (!confirmed) {
    outro("Nothing saved.");
    return false;
  }

  const s = spinner();
  s.start("Saving configuration");
  let saved: BreviConfig;
  try {
    saved = await saveConfig(draft);
  } catch (err) {
    s.error("Failed to save configuration");
    if (isZodLikeError(err)) {
      for (const line of formatZodIssues(err)) log.error(line);
    } else {
      log.error(errorMessage(err));
    }
    process.exit(1);
  }
  s.stop(`Saved to ${CONFIG_PATH}`);

  await offerFirecrackerSetup(saved);
  await checkCliDependencies(saved);

  outro(
    firstRun
      ? "Setup complete. Starting brevi..."
      : [
          "Next steps:",
          `  1. Run ${pc.cyan("npx @brevi/cli")} to start brevi and open the dashboard.`,
          "  2. In the Connections panel: connect Linear, GitHub, an agent key, and pick repositories.",
          `  3. Add the "brevi" label to a Linear ticket assigned to you.`,
        ].join("\n"),
  );
  return true;
}

/**
 * When the saved provider can use firecracker but the host isn't provisioned
 * yet, offers to run the setup flow inline. Declining changes nothing.
 */
async function offerFirecrackerSetup(saved: BreviConfig): Promise<void> {
  if (process.platform !== "linux" || saved.sandbox.provider === "process") return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;

  const problems = await collectFirecrackerProblems(saved.sandbox.firecracker, readPackageVersion());
  if (problems.length === 0) return;

  const setupNow = exitOnCancel(
    await confirm({
      message: "Set up the firecracker sandbox now? (downloads images, uses sudo)",
      initialValue: true,
    }),
  );
  if (!setupNow) return;

  const ready = await runSetup({ standalone: false });
  if (!ready) {
    log.warn(
      saved.sandbox.provider === "firecracker"
        ? "brevi start will fail until the remaining problems are fixed."
        : "brevi will fall back to the process provider (no isolation) until the remaining problems are fixed.",
    );
  }
}

async function loadExisting(): Promise<BreviConfig | undefined> {
  if (!existsSync(CONFIG_PATH)) return undefined;
  try {
    return await loadConfig();
  } catch (err) {
    log.warn(`Found a config at ${CONFIG_PATH}, but it could not be parsed: ${errorMessage(err)}`);
    return undefined;
  }
}

async function collectSandboxProvider(existing: BreviConfig | undefined): Promise<SandboxProvider> {
  const provider = exitOnCancel(
    await select({
      message: "Sandbox provider",
      initialValue: existing?.sandbox.provider ?? "auto",
      options: [
        {
          value: "auto" as const,
          label: "auto",
          hint: "recommended: firecracker on Linux with KVM, process otherwise",
        },
        {
          value: "firecracker" as const,
          label: "firecracker",
          hint: "strongest isolation; requires Linux + KVM",
        },
        { value: "process" as const, label: "process", hint: "no isolation, dev only" },
      ],
    }),
  );

  if (provider === "firecracker" && process.platform !== "linux") {
    log.warn(
      `firecracker needs Linux + KVM; this machine is ${process.platform}. brevi won't be able to start a sandbox until you switch providers or move to Linux.`,
    );
  }

  return provider;
}

function summarize(provider: string, existing: BreviConfig | undefined): string {
  const connection = (label: string, connected: boolean | undefined): string =>
    `${label}: ${connected ? "connected" : "not connected (use the dashboard)"}`;
  const repoKeys = existing ? Object.keys(existing.repos) : [];

  return [
    `Sandbox provider: ${provider}`,
    connection("Linear", Boolean(existing?.linear.apiKey)),
    connection("GitHub", Boolean(existing?.github.token)),
    connection("Anthropic", Boolean(existing?.agent.anthropicApiKey)),
    connection("Codex", Boolean(existing?.agent.codexApiKey)),
    repoKeys.length > 0
      ? `Repositories: ${repoKeys.join(", ")}`
      : "Repositories: none; pick them in the dashboard once GitHub is connected",
  ].join("\n");
}
