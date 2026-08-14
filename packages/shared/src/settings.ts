import { configSchema, type BreviConfig } from "./config.js";

/**
 * A deep-partial patch over `~/.brevi/config.json`, the body of
 * `PUT /api/settings`. Only the fields a form card touched are present, so a
 * save never clobbers a field the user did not edit (or one a hand edit
 * changed under them). `null` clears an optional field: `{"repos": {"web": null}}`
 * removes a repo mapping.
 * Objects merge key by key; arrays and scalars replace.
 */
export type ConfigPatch = { [key: string]: unknown };

/**
 * The fully-defaulted config: what a first launch writes and what every form
 * field shows as its placeholder or reset-to-default value. Derived from the
 * schema so the two can never drift.
 */
export const CONFIG_DEFAULTS: BreviConfig = configSchema.parse({});

/**
 * Credential fields the settings endpoint refuses to change. They are owned by
 * the Connect flows (`PUT /api/settings/credentials`), which verify each key
 * with its provider; `apiKey`, `refreshToken`, and the six `agent.*` keys are
 * also masked in every read, so accepting them from a form would let the mask
 * round-trip over a live secret. `linear.tokenExpiresAt` is not itself secret,
 * it is refused because the OAuth flow maintains it.
 *
 * `connect.linearClientSecret` is deliberately absent: it is a write-only form
 * field, guarded by MASKED_SECRET below rather than frozen. It is masked in
 * every read all the same, so it cannot be read back out of the
 * unauthenticated config channels.
 */
export const SETTINGS_SECRET_PATHS = [
  "linear.apiKey",
  "linear.refreshToken",
  "linear.tokenExpiresAt",
  "github.token",
  "agent.anthropicApiKey",
  "agent.claudeCodeOauthToken",
  "agent.codexApiKey",
  "agent.codexAuthJson",
  "agent.xaiApiKey",
  "agent.grokAuthJson",
];

/** What redactConfig substitutes for a set secret. Never accepted as a value. */
export const MASKED_SECRET = "***";

/**
 * Fields the process binds once at startup: the dashboard listener's address
 * and port, the fleet (worker channel) listener's address and port, and the
 * sandbox provider, which is created (and preflighted) during `start()`.
 * Everything else in the config is read per run or per poll, so it reaches the
 * next run without a restart.
 */
export const SETTINGS_RESTART_PATHS = [
  "server.port",
  "server.host",
  "fleet.host",
  "fleet.port",
  "sandbox.provider",
];

/** Whether a saved patch took effect immediately or waits for a restart. */
export type SettingsApplied = "live" | "restart";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keys that must never be written through a bracket expression: the assignment
 * would mutate the target's prototype instead of adding a property. Config
 * data arrives from a hand-editable file and from HTTP patches, so every write
 * into a plain-object tree filters them, including the ones that only reach a
 * tree the schema has already parsed.
 */
export function isUnsafeConfigKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

/**
 * Field paths are dotted, but a path segment can itself contain a dot: repo
 * keys come from GitHub repository names, and `next.js` or `socket.io` are
 * ordinary ones. A literal dot in a segment is escaped as `\.` (and a literal
 * backslash as `\\`), so splitting stays reversible.
 */
export function joinConfigPath(segments: string[]): string {
  return segments.map((segment) => segment.replace(/([\\.])/g, "\\$1")).join(".");
}

export function splitConfigPath(path: string): string[] {
  const segments: string[] = [];
  let current = "";
  for (let i = 0; i < path.length; i += 1) {
    const char = path[i];
    if (char === "\\" && i + 1 < path.length) {
      current += path[i + 1];
      i += 1;
    } else if (char === ".") {
      segments.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  segments.push(current);
  return segments;
}

/**
 * Merge a patch onto a config (or a clone of one), returning a new object.
 * `base` is never mutated, so a rejected patch leaves the live config alone.
 */
export function mergeConfigPatch(
  base: Record<string, unknown>,
  patch: ConfigPatch,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (isUnsafeConfigKey(key)) continue;
    if (value === null) {
      delete merged[key];
      continue;
    }
    const current = merged[key];
    // Recurse whenever the patch side is an object, even when the base has a
    // scalar (or nothing) there: assigning the patch object wholesale would
    // copy its own "__proto__"/"constructor" keys straight through, which
    // JSON.parse happily produces.
    merged[key] = isPlainObject(value)
      ? mergeConfigPatch(isPlainObject(current) ? current : {}, value)
      : value;
  }
  return merged;
}

/** Every leaf path a patch touches, dotted, e.g. "sandbox.firecracker.size". */
export function configPatchPaths(patch: ConfigPatch, prefix: string[] = []): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (isUnsafeConfigKey(key)) continue;
    const segments = [...prefix, key];
    if (isPlainObject(value) && Object.keys(value).length > 0) {
      paths.push(...configPatchPaths(value, segments));
    } else {
      paths.push(joinConfigPath(segments));
    }
  }
  return paths;
}

/** Read a dotted path out of a config, or undefined when any segment is missing. */
export function readConfigPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const segment of splitConfigPath(path)) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Turn the flat `{"agent.orchestratorEffort": "low"}` map a form card keeps
 * into the nested patch the endpoint takes.
 */
export function expandConfigPatch(entries: Record<string, unknown>): ConfigPatch {
  const patch: ConfigPatch = {};
  for (const [path, value] of Object.entries(entries)) {
    const segments = splitConfigPath(path);
    if (segments.some(isUnsafeConfigKey)) continue;
    const leaf = segments.pop();
    if (leaf === undefined) continue;
    let cursor = patch;
    for (const segment of segments) {
      const next = cursor[segment];
      if (!isPlainObject(next)) cursor[segment] = {};
      cursor = cursor[segment] as ConfigPatch;
    }
    cursor[leaf] = value;
  }
  return patch;
}

/** Whether a patch changes anything the running process cannot pick up live. */
export function needsRestart(before: BreviConfig, after: BreviConfig): boolean {
  return SETTINGS_RESTART_PATHS.some(
    (path) => JSON.stringify(readConfigPath(before, path)) !== JSON.stringify(readConfigPath(after, path)),
  );
}

/**
 * Credential fields a patch would change, compared on the *merged and parsed*
 * config rather than on the patch itself. Matching patch paths is not enough:
 * `{"linear": null}` names no secret path, but deleting the section makes the
 * schema's defaults refill it with empty strings, silently disconnecting the
 * provider. Comparing values catches every route to the same outcome.
 */
export function changedSecretPaths(before: BreviConfig, after: BreviConfig): string[] {
  return SETTINGS_SECRET_PATHS.filter(
    (path) => readConfigPath(before, path) !== readConfigPath(after, path),
  );
}
