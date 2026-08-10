import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CONFIG_PATH, configSchema, type BreviConfig } from "@brevi/shared";

export async function loadConfig(path: string = CONFIG_PATH): Promise<BreviConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(`No brevi config found at ${path}. Run \`brevi init\` first.`);
  }
  return configSchema.parse(JSON.parse(raw));
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
