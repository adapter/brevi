import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isContainedRegularFile, MEMORIES_DIR, type RepoMemory } from "@brevi/shared";

/**
 * Per-repository memories: the durable half of what a run learns. Every run
 * boots a fresh microVM with a fresh checkout, so anything the agent worked
 * out about the repo (which command actually builds it, which module owns a
 * concern, which trap cost it twenty minutes) would die with the VM and be
 * rediscovered, at full token price, by the next ticket. Memories are kept
 * on the host under ~/.brevi/memories/<repo>.json, injected into the next
 * run's prompt, and topped up from `.brevi/memories.md` when a run finishes.
 *
 * Storage mirrors RunStore: an in-memory map as the read model and disk writes
 * serialized through one promise chain. It differs in one deliberate way, for
 * one reason that runs through this whole module: memories are an
 * optimization, so nothing here may fail a run or stop the orchestrator
 * booting. Reads skip what they cannot parse and writes swallow their errors.
 */

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Longest a single memory may be. Past this the agent is writing prose, not a fact. */
const MAX_MEMORY_CHARS = 300;

/** Cap on what one run may contribute, so a chatty run cannot flood the store. */
const MAX_PER_RUN = 10;

/** Collapse a candidate memory to a single tidy line, or "" when nothing is left. */
function normalizeMemory(raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length <= MAX_MEMORY_CHARS) return text;
  const cut = text.slice(0, MAX_MEMORY_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > MAX_MEMORY_CHARS / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
}

/** Identity for dedupe: same fact reworded slightly should not be stored twice. */
function dedupeKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Pull memories out of the markdown the agent wrote. Only bullets count, which
 * is exactly what the prompt asks for: prose lines are prose, and a memory that
 * should not have been stored is worse than one that was never captured, since
 * every later run in the repo is handed it.
 */
function parseMemories(markdown: string): string[] {
  const candidates: string[] = [];
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("```")) continue;
    const bullet = /^([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (!bullet) continue;
    const text = normalizeMemory(bullet[2] ?? "");
    if (text) candidates.push(text);
  }

  const seen = new Set<string>();
  const memories: string[] = [];
  for (const text of candidates) {
    const key = dedupeKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    memories.push(text);
    if (memories.length >= MAX_PER_RUN) break;
  }
  return memories;
}

/**
 * Read the memories a run wrote, from the workspace pulled out of the sandbox.
 * The file is agent-controlled, so it goes through the same containment check
 * as every other pulled artifact; anything unreadable simply yields nothing.
 */
export async function readRunMemories(pulledDir: string): Promise<string[]> {
  const path = join(pulledDir, ".brevi", "memories.md");
  if (!(await isContainedRegularFile(pulledDir, path))) return [];
  try {
    return parseMemories(await readFile(path, "utf8"));
  } catch {
    return [];
  }
}

/**
 * Newest first, then by how often the fact has been rediscovered. This is both
 * the order memories are shown in and the order they are kept in: eviction
 * takes from the tail, so a memory no run has reaffirmed in a long time is the
 * first to go.
 */
function byUsefulness(a: RepoMemory, b: RepoMemory): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return b.hits - a.hits;
}

/**
 * Memories are keyed by the repository itself ("owner/name"), never by the
 * config mapping that pointed at it. A mapping key is editable: repoint
 * `repos.web.remote` at another repository, or delete the key and later reuse
 * it, and memories keyed by "web" would hand the first run against the new
 * repository a set of confident facts about a different one. Keying by the
 * remote degrades the other way instead: rename the repository on GitHub and
 * the next run simply starts cold.
 *
 * Lowercased because GitHub treats owner and name case-insensitively, so a
 * mapping spelled `Acme/Web` and a pull request on `acme/web` are the same
 * repository and must share one store.
 */
export function memoryKeyFor(remote: string): string {
  return remote.trim().toLowerCase();
}

/**
 * One file per repository, named after it. Keys are lowercased "owner/name"
 * (memoryKeyFor) and repo remotes are validated against `owner/name` by the
 * config schema, so the only character to escape is the slash and the result
 * always round-trips.
 */
const fileNameFor = (repo: string): string => `${encodeURIComponent(repo)}.json`;
const repoFromFileName = (name: string): string => decodeURIComponent(name.slice(0, -".json".length));

/** Coerce one entry read off disk into a usable memory, or null when it is not one. */
function reviveMemory(raw: RepoMemory): RepoMemory | null {
  if (typeof raw?.id !== "string" || !raw.id || typeof raw.text !== "string" || !raw.text) return null;
  const stamp = typeof raw.updatedAt === "string" ? raw.updatedAt : "";
  // A hand-edited file must not poison the sort comparator with NaN.
  return { ...raw, updatedAt: stamp, createdAt: raw.createdAt ?? stamp, hits: Number(raw.hits) || 1 };
}

export class MemoryStore {
  readonly dir: string;
  #repos = new Map<string, RepoMemory[]>();
  /** Serializes all disk writes so two runs finishing together cannot interleave. */
  #io: Promise<void> = Promise.resolve();

  constructor(dir: string = MEMORIES_DIR) {
    this.dir = dir;
  }

  /**
   * Load what is on disk. Nothing here throws: this runs during orchestrator
   * startup, and neither a stray file in the memories directory nor an
   * unusable directory (unreadable, or a plain file sitting where it belongs)
   * may stop brevi from booting. The worst case is starting with an empty
   * store, which costs some exploration and nothing else.
   */
  async init(): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      for (const name of await readdir(this.dir)) {
        if (!name.endsWith(".json")) continue;
        try {
          const parsed = JSON.parse(await readFile(join(this.dir, name), "utf8")) as RepoMemory[];
          if (!Array.isArray(parsed)) continue;
          const memories = parsed.map(reviveMemory).filter((m): m is RepoMemory => m !== null);
          if (memories.length > 0) this.#repos.set(repoFromFileName(name), memories.sort(byUsefulness));
        } catch {
          continue; // unreadable, not JSON, or an undecodable name; skip the file
        }
      }
    } catch (error) {
      console.error(`[brevi] memories unavailable at ${this.dir}: ${message(error)}`);
    }
  }

  /** What is remembered about one repository ("owner/name"), newest first. */
  list(repo: string): RepoMemory[] {
    return this.#repos.get(repo) ?? [];
  }

  /** Every repo that has something remembered, for the dashboard's Memory page. */
  all(): Record<string, RepoMemory[]> {
    const out: Record<string, RepoMemory[]> = {};
    for (const [repo, memories] of this.#repos) {
      if (memories.length > 0) out[repo] = memories;
    }
    return out;
  }

  /**
   * Merge one run's memories in. A fact that is already known is reaffirmed
   * (its hit count and recency go up) rather than duplicated, and the repo is
   * trimmed back to `maxEntries` afterwards.
   */
  async record(
    repo: string,
    texts: string[],
    options: { maxEntries: number; ident?: string },
  ): Promise<{ added: number; reaffirmed: number }> {
    if (texts.length === 0) return { added: 0, reaffirmed: 0 };
    const now = new Date().toISOString();
    const memories = [...this.list(repo)];
    const byKey = new Map(memories.map((memory) => [dedupeKey(memory.text), memory]));
    let added = 0;
    let reaffirmed = 0;

    for (const raw of texts) {
      const text = normalizeMemory(raw);
      const key = dedupeKey(text);
      if (!key) continue;
      const existing = byKey.get(key);
      if (existing) {
        existing.hits += 1;
        existing.updatedAt = now;
        existing.ident = options.ident ?? existing.ident;
        reaffirmed += 1;
        continue;
      }
      const memory: RepoMemory = {
        id: randomUUID(),
        text,
        createdAt: now,
        updatedAt: now,
        hits: 1,
        ...(options.ident ? { ident: options.ident } : {}),
      };
      memories.push(memory);
      byKey.set(key, memory);
      added += 1;
    }

    memories.sort(byUsefulness);
    this.#repos.set(repo, memories.slice(0, Math.max(1, options.maxEntries)));
    await this.#persist(repo);
    return { added, reaffirmed };
  }

  /** Drop one memory that turned out to be wrong. */
  async forget(repo: string, id: string): Promise<boolean> {
    const memories = this.#repos.get(repo);
    if (!memories) return false;
    const remaining = memories.filter((memory) => memory.id !== id);
    if (remaining.length === memories.length) return false;
    await this.#delete(repo, remaining, memories);
    return true;
  }

  /** Forget everything about one repo. */
  async clear(repo: string): Promise<boolean> {
    const memories = this.#repos.get(repo);
    if (!memories) return false;
    await this.#delete(repo, undefined, memories);
    return true;
  }

  /** Wait for all queued disk writes to land. */
  async flush(): Promise<void> {
    await this.#io;
  }

  /**
   * Apply a deletion the user asked for, rolling back and rethrowing when the
   * write fails. Recording is best effort, but a delete that only happened in
   * memory would report success, leave the file on disk, and hand the memory
   * back to every run after the next restart.
   */
  async #delete(repo: string, next: RepoMemory[] | undefined, previous: RepoMemory[]): Promise<void> {
    if (next) this.#repos.set(repo, next);
    else this.#repos.delete(repo);
    const error = await this.#persist(repo);
    if (!error) return;
    // Roll back only what is still ours: a run that finished in the meantime
    // has written newer state we must not clobber.
    if (this.#repos.get(repo) === next) this.#repos.set(repo, previous);
    throw error;
  }

  /** Resolves to the write's error rather than rejecting; see #enqueue. */
  #persist(repo: string): Promise<Error | null> {
    const memories = this.#repos.get(repo);
    const body = memories?.length ? `${JSON.stringify(memories, null, 2)}\n` : undefined;
    return this.#enqueue(async () => {
      const path = join(this.dir, fileNameFor(repo));
      if (body) await writeFile(path, body);
      else await rm(path, { force: true });
    });
  }

  /**
   * Unlike RunStore's equivalent, this never rejects: it reports the failure
   * as a value instead. A run awaits `record` on its way out, after the agent
   * has done all its work but before the branch is pushed, so a full disk or
   * an unwritable ~/.brevi must cost the run its memories, never its pull
   * request. Callers that do need to fail (the delete commands) check it.
   */
  #enqueue(task: () => Promise<void>): Promise<Error | null> {
    const next = this.#io.then(task, task).then(
      () => null,
      (raw: unknown): Error => {
        const error = raw instanceof Error ? raw : new Error(String(raw));
        console.error(`[brevi] memory store write failed: ${error.message}`);
        return error;
      },
    );
    // Keep the chain itself clean so one failed write cannot reject the next.
    this.#io = next.then(() => undefined);
    return next;
  }
}

/**
 * The memory texts that fit the prompt's character budget, most recently
 * confirmed first. The block only pays for itself while it stays cheaper than
 * the exploration it replaces, so the tail is dropped rather than the budget.
 */
export function selectMemories(memories: RepoMemory[], maxChars: number): string[] {
  const selected: string[] = [];
  let used = 0;
  for (const memory of memories) {
    // "- " plus the trailing newline the rendered bullet costs.
    const cost = memory.text.length + 3;
    // Skipped rather than stopped at: one long memory at the head must not
    // suppress every shorter one behind it.
    if (used + cost > maxChars) continue;
    used += cost;
    selected.push(memory.text);
  }
  return selected;
}
