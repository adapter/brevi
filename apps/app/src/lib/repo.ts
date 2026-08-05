import type { BreviConfig } from "@brevi/shared";

/**
 * Display name for a ticket's repo key: the owner/name remote when the config
 * knows the mapping, the bare key otherwise (e.g. before config has loaded).
 */
export function repoDisplay(
  config: BreviConfig | null,
  key: string | undefined,
): string | undefined {
  if (!key) return undefined;
  return config?.repos[key]?.remote ?? key;
}
