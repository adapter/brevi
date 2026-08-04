import { existsSync } from "node:fs";
import { loadConfig, saveConfig } from "@brevi/orchestrator";
import { CONFIG_PATH, type BreviConfig, type RepoConfig } from "@brevi/shared";
import { confirm, intro, log, note, outro, select, spinner, text } from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { errorMessage, exitOnCancel, formatZodIssues, isZodLikeError } from "../lib/util.js";

type SandboxProvider = "auto" | "firecracker" | "process";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Configure brevi: repositories and sandbox provider")
    .action(async () => {
      try {
        await runInit();
      } catch (err) {
        log.error(errorMessage(err));
        process.exit(1);
      }
    });
}

async function runInit(): Promise<void> {
  intro(pc.bgCyan(pc.black(" brevi init ")));

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
      return;
    }
  }

  log.info(
    "Credentials (Linear, GitHub, Anthropic/Codex keys) are connected later from the dashboard's Connections panel.",
  );

  const { repos, defaultRepo } = await collectRepos(existing);
  const provider = await collectSandboxProvider(existing);

  // Preserve everything else from an existing config (credentials, triggers, ...).
  const draft = {
    ...existing,
    repos,
    defaultRepo,
    sandbox: { ...existing?.sandbox, provider },
  };

  note(summarize(draft, existing), "Configuration summary");

  const confirmed = exitOnCancel(
    await confirm({ message: "Save this configuration?", initialValue: true }),
  );
  if (!confirmed) {
    outro("Nothing saved.");
    return;
  }

  const s = spinner();
  s.start("Saving configuration");
  try {
    await saveConfig(draft);
  } catch (err) {
    s.stop("Failed to save configuration", 1);
    if (isZodLikeError(err)) {
      for (const line of formatZodIssues(err)) log.error(line);
    } else {
      log.error(errorMessage(err));
    }
    process.exit(1);
  }
  s.stop(`Saved to ${CONFIG_PATH}`);

  outro(
    [
      "Next steps:",
      `  1. Run ${pc.cyan("npx @brevi/cli ui")} to start brevi and open the dashboard.`,
      "  2. Connect Linear, GitHub, and an agent API key in the Connections panel.",
      `  3. Tag a Linear ticket with "@brevi" (or add the "brevi" label).`,
    ].join("\n"),
  );
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

async function collectRepos(
  existing: BreviConfig | undefined,
): Promise<{ repos: Record<string, RepoConfig>; defaultRepo?: string }> {
  const existingKeys = existing ? Object.keys(existing.repos) : [];
  if (existing && existingKeys.length > 0) {
    log.info(
      `Existing repositories: ${existingKeys
        .map((key) => `${key} (${existing.repos[key]?.remote})`)
        .join(", ")}`,
    );
    const keep = exitOnCancel(
      await confirm({ message: "Keep the existing repository configuration?", initialValue: true }),
    );
    if (keep) {
      return { repos: existing.repos, defaultRepo: existing.defaultRepo };
    }
  }

  const repos: Record<string, RepoConfig> = {};
  let defaultRepo: string | undefined;
  let first = true;

  for (;;) {
    if (first) {
      log.step("Add at least one repository.");
    } else {
      const addMore = exitOnCancel(
        await confirm({ message: "Add another repository?", initialValue: false }),
      );
      if (!addMore) break;
    }

    const key = exitOnCancel(
      await text({
        message: 'Repository key (short name, e.g. "web")',
        validate: (value) => {
          if (value.trim().length === 0) return "Required.";
          if (repos[value]) return "That key is already in use.";
          return undefined;
        },
      }),
    );
    const remote = exitOnCancel(
      await text({
        message: `Git remote for "${key}" (owner/name)`,
        placeholder: "owner/name",
        validate: (value) => (/^[\w.-]+\/[\w.-]+$/.test(value) ? undefined : 'Expected "owner/name".'),
      }),
    );
    const defaultBranch = exitOnCancel(
      await text({ message: "Default branch", initialValue: "main", defaultValue: "main" }),
    );
    const devCommand = exitOnCancel(
      await text({
        message: "Dev command (optional, used for demo capture)",
        placeholder: "npm run dev",
      }),
    );
    const devUrl = exitOnCancel(
      await text({
        message: "Dev URL (optional, used for demo capture)",
        placeholder: "http://localhost:3000",
        validate: (value) => {
          if (value.trim().length === 0) return undefined;
          try {
            new URL(value);
            return undefined;
          } catch {
            return "Must be a valid URL.";
          }
        },
      }),
    );

    repos[key] = {
      remote,
      defaultBranch: defaultBranch.trim() || "main",
      devCommand: devCommand.trim() || undefined,
      devUrl: devUrl.trim() || undefined,
    };
    if (first) defaultRepo = key;
    first = false;
  }

  return { repos, defaultRepo };
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
          hint: "recommended — firecracker on Linux with KVM, process otherwise",
        },
        {
          value: "firecracker" as const,
          label: "firecracker",
          hint: "Linux + KVM required — strongest isolation",
        },
        { value: "process" as const, label: "process", hint: "no isolation — dev only" },
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

function summarize(
  draft: { repos: Record<string, RepoConfig>; defaultRepo?: string; sandbox: { provider: string } },
  existing: BreviConfig | undefined,
): string {
  const repoLines = Object.entries(draft.repos)
    .map(
      ([key, repo]) =>
        `  ${key}: ${repo.remote} (${repo.defaultBranch})${key === draft.defaultRepo ? " [default]" : ""}`,
    )
    .join("\n");

  const connection = (label: string, connected: boolean | undefined): string =>
    `${label}: ${connected ? "connected" : "not connected — use the dashboard"}`;

  return [
    connection("Linear", Boolean(existing?.linear.apiKey)),
    connection("GitHub", Boolean(existing?.github.token)),
    connection("Anthropic", Boolean(existing?.agent.anthropicApiKey)),
    connection("Codex", Boolean(existing?.agent.codexApiKey)),
    "Repositories:",
    repoLines,
    `Sandbox provider: ${draft.sandbox.provider}`,
  ].join("\n");
}
