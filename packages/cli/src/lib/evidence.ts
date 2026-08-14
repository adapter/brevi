import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ORCHESTRATOR_LOG_PATH } from "@brevi/orchestrator";
import { RUNS_DIR, redactConfig, type BreviConfig } from "@brevi/shared";

/**
 * Builds the evidence bundle `brevi doctor --ai` hands to `claude -p`: the
 * flattened check results, the redacted config, and bounded log tails. Every
 * raw secret value is scrubbed from the whole payload, in both its plain and
 * JSON-escaped forms, so tokens that were echoed into a log can never reach
 * the diagnosis prompt.
 */

export interface EvidenceCheck {
  section: string;
  name: string;
  status: string;
  detail: string;
  hint?: string;
}

const MIN_SECRET_LENGTH = 6;
/** Codex auth.json leaves below this length are structural ("chatgpt", ids), not tokens. */
const MIN_LEAF_LENGTH = 8;

const TAIL_LINES = 80;
const TAIL_MAX_CHARS = 8000;

export async function buildEvidenceBundle(
  checks: EvidenceCheck[],
  config: BreviConfig | undefined,
): Promise<string> {
  const secrets = config ? collectSecrets(config) : [];
  const scrub = (text: string | null): string | null =>
    text === null ? null : scrubSecrets(text, secrets);

  const bundle = {
    checks,
    config: config ? redactConfig(config) : null,
    orchestratorLogTail: scrub(await fileTail(ORCHESTRATOR_LOG_PATH)),
    latestRunEvents: scrub(await latestRunEventsTail()),
  };

  // Scrubbing the serialized form again catches secrets whose spelling the
  // JSON escaping changed, and any fragment that landed in a check detail.
  return scrubSecrets(JSON.stringify(bundle, null, 2), secrets);
}

/**
 * Every raw secret value from the parsed config: the credential fields
 * themselves plus, for the Codex and Grok auth.json blobs, each string leaf inside it
 * (access, refresh, and ID tokens, API key). A token logged on its own line
 * would never match the whole multiline document, so the leaves must be
 * scrubbed individually.
 */
export function collectSecrets(config: BreviConfig): string[] {
  const secrets = [
    config.linear.apiKey,
    config.github.token,
    config.agent.anthropicApiKey,
    config.agent.claudeCodeOauthToken,
    config.agent.codexApiKey,
    config.agent.codexAuthJson,
    config.agent.xaiApiKey,
    config.agent.grokAuthJson,
    config.connect.linearClientSecret,
    ...codexAuthLeaves(config.agent.codexAuthJson),
    ...codexAuthLeaves(config.agent.grokAuthJson),
  ];
  // Longest first, so a secret containing another is replaced whole.
  return [...new Set(secrets.filter((value) => value.length >= MIN_SECRET_LENGTH))].sort(
    (a, b) => b.length - a.length,
  );
}

/** Replace each secret with "***", in both its raw and JSON-escaped spellings. */
export function scrubSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    out = out.split(secret).join("***");
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) out = out.split(escaped).join("***");
  }
  return out;
}

function codexAuthLeaves(raw: string): string[] {
  if (!raw) return [];
  try {
    const leaves: string[] = [];
    collectStringLeaves(JSON.parse(raw), leaves);
    return leaves.filter((leaf) => leaf.length >= MIN_LEAF_LENGTH);
  } catch {
    // Not JSON after all: fall back to its word-sized chunks so token-like
    // pieces still get scrubbed wherever they appear on their own.
    return raw.split(/[\s"',:{}[\]]+/).filter((chunk) => chunk.length >= MIN_LEAF_LENGTH);
  }
}

function collectStringLeaves(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, out);
  } else if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) collectStringLeaves(nested, out);
  }
}

/** Bounded tail of a text file, or null when it cannot be read. */
async function fileTail(path: string): Promise<string | null> {
  try {
    return boundedTail(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function boundedTail(raw: string): string {
  const lines = raw.split("\n").filter((line) => line.trim());
  const tail = lines.slice(-TAIL_LINES).join("\n");
  return tail.length > TAIL_MAX_CHARS ? tail.slice(-TAIL_MAX_CHARS) : tail;
}

/**
 * Best-effort tail of the most recently active run's event log, supplemental
 * to the orchestrator log; null when no run has one.
 */
async function latestRunEventsTail(): Promise<string | null> {
  try {
    const entries = await readdir(RUNS_DIR, { withFileTypes: true });
    let newest: { path: string; mtimeMs: number } | undefined;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const eventsPath = join(RUNS_DIR, entry.name, "events.jsonl");
      try {
        const info = await stat(eventsPath);
        if (!newest || info.mtimeMs > newest.mtimeMs) newest = { path: eventsPath, mtimeMs: info.mtimeMs };
      } catch {
        // This run has no events file.
      }
    }
    if (!newest) return null;
    return boundedTail(await readFile(newest.path, "utf8"));
  } catch {
    return null;
  }
}
