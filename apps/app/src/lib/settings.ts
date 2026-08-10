import { useCallback, useMemo, useState } from "react";
// Imported from the browser-safe subpaths rather than the package root: the
// root re-exports paths.ts, which pulls in node:os.
import { configSchema, type BreviConfig } from "@brevi/shared/config";
import {
  CONFIG_DEFAULTS,
  expandConfigPatch,
  mergeConfigPatch,
  readConfigPath,
  SETTINGS_RESTART_PATHS,
  type SettingsApplied,
} from "@brevi/shared/settings";
import { api } from "./api";

/**
 * One settings card's edit buffer. Fields are addressed by their dotted path
 * in config.json ("agent.orchestratorEffort"), so a card owns exactly the
 * paths it renders and its save touches nothing else.
 */
export interface SettingsDraft {
  /** The edited value, falling back to what the orchestrator last sent. */
  value: (path: string) => unknown;
  set: (path: string, value: unknown) => void;
  /** Drop one field's edit, e.g. on Escape. */
  revert: (path: string) => void;
  /** Put a field back to the schema default. */
  reset: (path: string) => void;
  /** Whether a field currently holds the schema default. */
  isDefault: (path: string) => boolean;
  /** The zod message for a field, from validating the whole edited config. */
  issue: (path: string) => string | undefined;
  dirty: boolean;
  /** True while any edited field fails validation; Save stays disabled. */
  invalid: boolean;
  saving: boolean;
  /** Server-side rejection of the last save. */
  error: string | null;
  /** Set after a successful save, until the next edit. */
  applied: SettingsApplied | null;
  save: () => void;
  discard: () => void;
}

/** Whether a field needs a brevi restart before it takes effect. */
export function needsRestart(path: string): boolean {
  return SETTINGS_RESTART_PATHS.includes(path);
}

/** The schema default for a field, for placeholders and reset-to-default. */
export function defaultValue(path: string): unknown {
  return readConfigPath(CONFIG_DEFAULTS, path);
}

/**
 * The default rendered as placeholder text. Empty defaults have nothing
 * useful to show, and neither do objects.
 */
export function defaultPlaceholder(path: string): string | undefined {
  const value = defaultValue(path);
  if (typeof value === "string") return value || undefined;
  if (typeof value === "number") return String(value);
  return undefined;
}

/**
 * Edit buffer for one card. Validation runs the *whole* edited config through
 * the same `configSchema` the orchestrator parses with, so the messages shown
 * inline are literally the ones a save would come back with.
 */
export function useSettingsDraft(
  config: BreviConfig,
  onConfig: (config: BreviConfig) => void,
): SettingsDraft {
  const [entries, setEntries] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<SettingsApplied | null>(null);

  const patch = useMemo(() => expandConfigPatch(entries), [entries]);

  const issues = useMemo(() => {
    const found = new Map<string, string>();
    if (Object.keys(entries).length === 0) return found;
    const merged = mergeConfigPatch(
      structuredClone(config) as unknown as Record<string, unknown>,
      patch,
    );
    const result = configSchema.safeParse(merged);
    if (result.success) return found;
    for (const issue of result.error.issues) {
      const path = issue.path.join(".");
      if (!found.has(path)) found.set(path, issue.message);
    }
    return found;
  }, [config, entries, patch]);

  const value = useCallback(
    (path: string) => (path in entries ? entries[path] : readConfigPath(config, path)),
    [config, entries],
  );

  const set = useCallback((path: string, next: unknown) => {
    setError(null);
    setApplied(null);
    setEntries((current) => ({ ...current, [path]: next }));
  }, []);

  const revert = useCallback((path: string) => {
    setEntries((current) => {
      if (!(path in current)) return current;
      const next = { ...current };
      delete next[path];
      return next;
    });
  }, []);

  const reset = useCallback(
    (path: string) => {
      // Optional fields have no default at all; null is how the endpoint is
      // told to drop a key rather than write a value.
      set(path, defaultValue(path) ?? null);
    },
    [set],
  );

  const isDefault = useCallback(
    (path: string) => JSON.stringify(value(path)) === JSON.stringify(defaultValue(path)),
    [value],
  );

  const save = useCallback(() => {
    setSaving(true);
    setError(null);
    // The request is in flight for a while, and the card stays editable. Only
    // the values that were actually submitted are cleared on success: wiping
    // the whole buffer would throw away anything typed in the meantime.
    const submitted = entries;
    api
      .updateSettings(patch)
      .then((response) => {
        onConfig(response.config);
        setEntries((current) => {
          const remaining = { ...current };
          for (const [path, value] of Object.entries(submitted)) {
            if (JSON.stringify(remaining[path]) === JSON.stringify(value)) delete remaining[path];
          }
          return remaining;
        });
        setApplied(response.applied);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "The orchestrator did not respond.");
      })
      .finally(() => setSaving(false));
  }, [entries, onConfig, patch]);

  const discard = useCallback(() => {
    setEntries({});
    setError(null);
    setApplied(null);
  }, []);

  return {
    value,
    set,
    revert,
    reset,
    isDefault,
    issue: (path) => issues.get(path),
    dirty: Object.keys(entries).length > 0,
    invalid: issues.size > 0,
    saving,
    error,
    applied,
    save,
    discard,
  };
}
