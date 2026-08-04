import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";

/** Root directory for all brevi state: config, run history, artifacts, VM images. */
export const BREVI_HOME = join(homedir(), ".brevi");
export const CONFIG_PATH = join(BREVI_HOME, "config.json");
export const RUNS_DIR = join(BREVI_HOME, "runs");
export const IMAGES_DIR = join(BREVI_HOME, "images");
export const WORKSPACES_DIR = join(BREVI_HOME, "workspaces");

export const DEFAULT_PORT = 4400;

export const repoConfigSchema = z.object({
  /** Git remote in "owner/name" form. */
  remote: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'expected "owner/name"'),
  defaultBranch: z.string().default("main"),
  /** Optional local checkout to clone from instead of the network. */
  path: z.string().optional(),
  /** Command that produces a runnable dev server, used for demo capture. */
  devCommand: z.string().optional(),
  /** URL the dev server listens on once up, used for demo capture. */
  devUrl: z.string().optional(),
});

export const firecrackerConfigSchema = z.object({
  /** Path to the firecracker binary. */
  binary: z.string().default("firecracker"),
  /** Uncompressed Linux kernel image (vmlinux). */
  kernelImage: z.string().default(join(IMAGES_DIR, "vmlinux")),
  /** Ext4 rootfs with node, git, and the coding agent preinstalled. */
  rootfs: z.string().default(join(IMAGES_DIR, "rootfs.ext4")),
  vcpus: z.number().int().min(1).default(2),
  memMib: z.number().int().min(512).default(4096),
});

export const configSchema = z.object({
  linear: z
    .object({
      /** Empty = not connected yet; set via the dashboard's Connections panel. */
      apiKey: z.string().default(""),
      /** Restrict polling to these team keys (e.g. ["ENG"]). Empty = all teams. */
      teamKeys: z.array(z.string()).default([]),
    })
    .prefault({}),
  github: z
    .object({
      /** Empty = not connected yet; set via the dashboard's Connections panel. */
      token: z.string().default(""),
    })
    .prefault({}),
  /** Map of repo key -> repo config. Ticket labels or project names select the key. */
  repos: z.record(z.string(), repoConfigSchema).prefault({}),
  /** Repo key to use when a ticket doesn't match any mapping. */
  defaultRepo: z.string().optional(),
  agent: z
    .object({
      /** Coding agent CLI executed inside the sandbox. */
      command: z.string().default("claude"),
      args: z.array(z.string()).default([]),
      model: z.string().optional(),
      /** Passed to the sandboxed agent as ANTHROPIC_API_KEY. Empty = use host env. */
      anthropicApiKey: z.string().default(""),
      /** Claude Code OAuth token (host-discovered), passed as CLAUDE_CODE_OAUTH_TOKEN. */
      claudeCodeOauthToken: z.string().default(""),
      /** Passed to the sandboxed agent as OPENAI_API_KEY (for Codex agents). */
      codexApiKey: z.string().default(""),
      /**
       * Codex CLI ChatGPT login (the contents of ~/.codex/auth.json), for
       * accounts without an API key. Mounted into the sandbox via CODEX_HOME.
       */
      codexAuthJson: z.string().default(""),
    })
    .prefault({}),
  sandbox: z
    .object({
      /** "auto" picks firecracker on Linux with KVM, process otherwise. */
      provider: z.enum(["auto", "firecracker", "process"]).default("auto"),
      firecracker: firecrackerConfigSchema.prefault({}),
      /** Hard wall-clock limit for a single run. */
      timeoutMinutes: z.number().int().min(1).default(60),
    })
    .prefault({}),
  /** OAuth app settings powering the dashboard's one-click Connect flows. */
  connect: z
    .object({
      /**
       * brevi's hosted OAuth backend, used when no personal OAuth app is
       * configured below. Point at your own deployment of apps/api to
       * self-host; empty disables hosted flows entirely.
       */
      apiBase: z.string().default("https://api.brevi.dev"),
      /** Personal GitHub OAuth app client id (device flow), overrides apiBase. */
      githubClientId: z.string().default(""),
      /** Personal Linear OAuth app credentials (redirect flow), override apiBase. */
      linearClientId: z.string().default(""),
      linearClientSecret: z.string().default(""),
    })
    .prefault({}),
  trigger: z
    .object({
      /** Mention that opts a ticket in, searched in title/description/labels. */
      tag: z.string().default("@brevi"),
      /** Label name that also opts a ticket in. */
      label: z.string().default("brevi"),
      /** Label or title prefix marking a ticket as research-only. */
      spikeMarker: z.string().default("SPIKE"),
    })
    .prefault({}),
  server: z.object({ port: z.number().int().default(DEFAULT_PORT) }).prefault({}),
  pollIntervalSeconds: z.number().int().min(10).default(60),
});

export type BreviConfig = z.infer<typeof configSchema>;
export type RepoConfig = z.infer<typeof repoConfigSchema>;
export type FirecrackerConfig = z.infer<typeof firecrackerConfigSchema>;

/** Mask a secret when set; keep "" so clients can tell "not connected" apart. */
function mask(secret: string): string {
  return secret ? "***" : "";
}

/** Config with secrets stripped, safe to send to the dashboard. */
export function redactConfig(config: BreviConfig): BreviConfig {
  return {
    ...config,
    linear: { ...config.linear, apiKey: mask(config.linear.apiKey) },
    github: { ...config.github, token: mask(config.github.token) },
    agent: {
      ...config.agent,
      anthropicApiKey: mask(config.agent.anthropicApiKey),
      claudeCodeOauthToken: mask(config.agent.claudeCodeOauthToken),
      codexApiKey: mask(config.agent.codexApiKey),
      codexAuthJson: mask(config.agent.codexAuthJson),
    },
    connect: { ...config.connect, linearClientSecret: mask(config.connect.linearClientSecret) },
  };
}
