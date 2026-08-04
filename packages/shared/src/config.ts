import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";

/** Root directory for all brevi state: config, run history, artifacts, VM images. */
export const BREVI_HOME = process.env.BREVI_HOME ?? join(homedir(), ".brevi");
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
  linear: z.object({
    apiKey: z.string().min(1),
    /** Restrict polling to these team keys (e.g. ["ENG"]). Empty = all teams. */
    teamKeys: z.array(z.string()).default([]),
  }),
  github: z.object({
    token: z.string().min(1),
  }),
  /** Map of repo key -> repo config. Ticket labels or project names select the key. */
  repos: z.record(z.string(), repoConfigSchema).default({}),
  /** Repo key to use when a ticket doesn't match any mapping. */
  defaultRepo: z.string().optional(),
  agent: z
    .object({
      /** Coding agent CLI executed inside the sandbox. */
      command: z.string().default("claude"),
      args: z.array(z.string()).default([]),
      model: z.string().optional(),
    })
    .default({ command: "claude", args: [] }),
  sandbox: z
    .object({
      /** "auto" picks firecracker on Linux with KVM, process otherwise. */
      provider: z.enum(["auto", "firecracker", "process"]).default("auto"),
      firecracker: firecrackerConfigSchema.default({}),
      /** Hard wall-clock limit for a single run. */
      timeoutMinutes: z.number().int().min(1).default(60),
    })
    .default({}),
  trigger: z
    .object({
      /** Mention that opts a ticket in, searched in title/description/labels. */
      tag: z.string().default("@brevi"),
      /** Label name that also opts a ticket in. */
      label: z.string().default("brevi"),
      /** Label or title prefix marking a ticket as research-only. */
      spikeMarker: z.string().default("SPIKE"),
    })
    .default({}),
  server: z.object({ port: z.number().int().default(DEFAULT_PORT) }).default({}),
  pollIntervalSeconds: z.number().int().min(10).default(60),
});

export type BreviConfig = z.infer<typeof configSchema>;
export type RepoConfig = z.infer<typeof repoConfigSchema>;
export type FirecrackerConfig = z.infer<typeof firecrackerConfigSchema>;

/** Config with secrets stripped, safe to send to the dashboard. */
export function redactConfig(config: BreviConfig): BreviConfig {
  return {
    ...config,
    linear: { ...config.linear, apiKey: "***" },
    github: { ...config.github, token: "***" },
  };
}
