import { existsSync } from "node:fs";
import { loadConfig, saveConfig } from "@brevi/orchestrator";
import { collectBwrapProblems } from "@brevi/sandbox";
import { CONFIG_PATH, type BreviConfig } from "@brevi/shared";
import { confirm, intro, log, note, outro, spinner } from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { checkCliDependencies } from "../lib/dependencies.js";
import { errorMessage, exitOnCancel, formatZodIssues, isZodLikeError } from "../lib/util.js";
import { runSetup } from "./setup.js";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Create the brevi config")
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

  // Preserve everything else from an existing config (credentials, repos, ...).
  const draft = { ...existing };

  note(summarize(existing), "Configuration summary");

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

  await offerBwrapSetup();
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

/** On Linux, offer to install bubblewrap when it is missing. Declining changes nothing. */
async function offerBwrapSetup(): Promise<void> {
  if (process.platform !== "linux") return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;

  const problems = await collectBwrapProblems();
  if (problems.length === 0) return;

  const setupNow = exitOnCancel(
    await confirm({
      message: "Install bubblewrap now so this machine can execute runs?",
      initialValue: true,
    }),
  );
  if (!setupNow) return;

  const ready = await runSetup({ standalone: false });
  if (!ready) {
    log.warn("This machine cannot execute runs until bubblewrap is installed. Enroll a Linux worker, or re-run brevi setup.");
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

function summarize(existing: BreviConfig | undefined): string {
  const connection = (label: string, connected: boolean | undefined): string =>
    `${label}: ${connected ? "connected" : "not connected (use the dashboard)"}`;
  const repoKeys = existing ? Object.keys(existing.repos) : [];

  return [
    connection("Linear", Boolean(existing?.linear.apiKey)),
    connection("GitHub", Boolean(existing?.github.token)),
    connection("Anthropic", Boolean(existing?.agent.anthropicApiKey)),
    connection("Codex", Boolean(existing?.agent.codexApiKey)),
    connection("Grok", Boolean(existing?.agent.xaiApiKey || existing?.agent.grokAuthJson)),
    repoKeys.length > 0
      ? `Repositories: ${repoKeys.join(", ")}`
      : "Repositories: none; pick them in the dashboard once GitHub is connected",
  ].join("\n");
}
