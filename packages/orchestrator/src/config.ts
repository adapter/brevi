import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CONFIG_PATH, configSchema, type BreviConfig } from "@brevi/shared";

export async function loadConfig(path: string = CONFIG_PATH): Promise<BreviConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(`No brevi config found at ${path}. Run \`npx @brevi/cli\` to create one.`);
  }
  return configSchema.parse(JSON.parse(raw));
}

export interface EnsureConfigResult {
  config: BreviConfig;
  /** True only when there was no config file and this call just wrote the defaults. */
  firstLaunch: boolean;
}

/**
 * The config the CLI and the desktop app share. First launch has no file:
 * schema defaults are written to ~/.brevi/config.json so the orchestrator can
 * start, and `firstLaunch` is reported back so the caller can land on the
 * /setup route instead of the dashboard. Connections and the sandbox provider
 * are chosen there.
 */
export async function ensureConfig(path: string = CONFIG_PATH): Promise<EnsureConfigResult> {
  // Every top-level key in configSchema has a `.prefault({})`, so saving `{}`
  // yields a complete default config rather than a validation error.
  if (!existsSync(path)) return { config: await saveConfig({}, path), firstLaunch: true };
  return { config: await loadConfig(path), firstLaunch: false };
}

/** The serialized form of a config, exactly as saveConfig writes it. */
export function serializeConfig(config: BreviConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * Validate, then replace config.json in one step. The write goes to a
 * sibling temp file and is renamed into place, so a crash (or a reader
 * arriving mid-write) never sees a truncated or half-written config: the old
 * file stays intact until the new one is complete. Rejecting before the
 * rename also means an invalid config can't reach disk at all.
 *
 * The temp file is created 0600, and since the rename replaces the inode that
 * is the mode config.json ends up with. The file holds API tokens, so leaving
 * it at whatever the process umask produces (commonly 0644, readable by every
 * local user) is not acceptable.
 */
export async function saveConfig(
  config: unknown,
  path: string = CONFIG_PATH,
): Promise<BreviConfig> {
  const parsed = configSchema.parse(config);
  await mkdir(dirname(path), { recursive: true });
  // Random, not pid-based: two brevi processes pointed at one config file
  // would otherwise pick the same temp name only when they share a pid, but
  // a retry after a crash can, and clobbering a live temp file publishes the
  // other writer's bytes.
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, serializeConfig(parsed), { mode: 0o600 });
    await rename(temp, path);
  } catch (error) {
    // Never leave a token-bearing temp file behind on a failed save.
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  return parsed;
}
