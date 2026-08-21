import { existsSync } from "node:fs";
import { CONFIG_PATH, type BreviConfig } from "@brevi/shared";
import { loadConfig, saveConfig } from "@brevi/shared";

export interface EnsureConfigResult {
  config: BreviConfig;
  /** True only when there was no config file and this call just wrote the defaults. */
  firstLaunch: boolean;
}

/**
 * Mission Control's config. First launch has no file: schema
 * defaults are written to ~/.brevi/config.json so the orchestrator can start,
 * and `firstLaunch` is reported back so the caller can land the window on the
 * /setup route instead of the dashboard; the rest of setup (connections)
 * happens there.
 */
export async function ensureConfig(): Promise<EnsureConfigResult> {
  // Every top-level key in configSchema has a `.prefault({})`, so saving `{}`
  // yields a complete default config rather than a validation error.
  if (!existsSync(CONFIG_PATH)) return { config: await saveConfig({}), firstLaunch: true };
  return { config: await loadConfig(), firstLaunch: false };
}
