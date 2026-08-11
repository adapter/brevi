import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MEMORIES_DIR, type RepoMemory } from "@brevi/shared";
import { isContainedRegularFile } from "./safepath.js";

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
export function parseMemories(markdown: string): string[] {
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

/** Shape on disk. The key lives in the file, not in its name (see fileNameFor). */
interface MemoryFile {
  repo: string;
  memories: RepoMemory[];
}

/**
 * One file per repo key. Repo keys are user-chosen and may contain anything,
 * so the readable part of the name is sanitized down to a slug and the exact
 * key is disambiguated by a hash: two keys that differ only in case ("Web"
 * and "web") must not land on the same file on a case-insensitive filesystem.
 * The slug is cosmetic; the key itself is read back from the file's contents.
 */
function fileNameFor(repoKey: string): string {
  const slug = repoKey.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60);
  return `${slug}-${createHash("sha256").update(repoKey).digest("hex").slice(0, 8)}.json`;
}

/** Coerce one entry read off disk into a usable memory, or null when it is not one. */
function reviveMemory(raw: unknown): RepoMemory | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { id, text, createdAt, updatedAt, hits, ident } = raw as Record<string, unknown>;
  if (typeof id !== "string" || !id || typeof text !== "string" || !text) return null;
  // A hand-edited or partially written file must not poison the sort with NaN.
  const stamp = typeof updatedAt === "string" ? updatedAt : typeof createdAt === "string" ? createdAt : "";
  return {
    id,
    text,
    createdAt: typeof createdAt === "string" ? createdAt : stamp,
    updatedAt: stamp,
    hits: typeof hits === "number" && Number.isFinite(hits) && hits > 0 ? Math.floor(hits) : 1,
    ...(typeof ident === "string" && ident ? { ident } : {}),
  };
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
   * Load what is on disk. Anything unreadable is skipped rather than thrown:
   * this runs during orchestrator startup, and one stray file in the memories
   * directory must never stop brevi from booting.
   */
  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const entries = await readdir(this.dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      let file: MemoryFile;
      try {
        file = JSON.parse(await readFile(join(this.dir, entry.name), "utf8")) as MemoryFile;
      } catch {
        continue;
      }
      if (typeof file?.repo !== "string" || !file.repo || !Array.isArray(file.memories)) continue;
      const memories = file.memories.map(reviveMemory).filter((m): m is RepoMemory => m !== null);
      if (memories.length > 0) this.#repos.set(file.repo, memories.sort(byUsefulness));
    }
  }

  /** What is remembered about one repo, newest first. */
  list(repoKey: string): RepoMemory[] {
    return this.#repos.get(repoKey) ?? [];
  }

  /** Every repo that has something remembered, for the dashboard's Memory page. */
  all(): Record<string, RepoMemory[]> {
    const out: Record<string, RepoMemory[]> = {};
    for (const [repoKey, memories] of this.#repos) {
      if (memories.length > 0) out[repoKey] = memories;
    }
    return out;
  }

  /**
   * Merge one run's memories in. A fact that is already known is reaffirmed
   * (its hit count and recency go up) rather than duplicated, and the repo is
   * trimmed back to `maxEntries` afterwards.
   */
  async record(
    repoKey: string,
    texts: string[],
    options: { maxEntries: number; ident?: string },
  ): Promise<{ added: number; reaffirmed: number }> {
    if (texts.length === 0) return { added: 0, reaffirmed: 0 };
    const now = new Date().toISOString();
    const memories = [...this.list(repoKey)];
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
    this.#repos.set(repoKey, memories.slice(0, Math.max(1, options.maxEntries)));
    await this.#persist(repoKey);
    return { added, reaffirmed };
  }

  /** Drop one memory that turned out to be wrong. */
  async forget(repoKey: string, id: string): Promise<boolean> {
    const memories = this.#repos.get(repoKey);
    if (!memories) return false;
    const remaining = memories.filter((memory) => memory.id !== id);
    if (remaining.length === memories.length) return false;
    this.#repos.set(repoKey, remaining);
    await this.#persist(repoKey);
    return true;
  }

  /** Forget everything about one repo. */
  async clear(repoKey: string): Promise<boolean> {
    if (!this.#repos.has(repoKey)) return false;
    this.#repos.delete(repoKey);
    await this.#persist(repoKey);
    return true;
  }

  /** Wait for all queued disk writes to land. */
  async flush(): Promise<void> {
    await this.#io;
  }

  #persist(repoKey: string): Promise<void> {
    const memories = this.#repos.get(repoKey);
    const body =
      memories && memories.length > 0
        ? `${JSON.stringify({ repo: repoKey, memories } satisfies MemoryFile, null, 2)}\n`
        : undefined;
    return this.#enqueue(async () => {
      const path = join(this.dir, fileNameFor(repoKey));
      if (!body) {
        await rm(path, { force: true });
        return;
      }
      await mkdir(this.dir, { recursive: true });
      await writeFile(path, body);
    });
  }

  /**
   * Unlike RunStore's equivalent, this hands callers the *swallowing* promise:
   * a run awaits `record` on its way out, after the agent has done all its
   * work but before the branch is pushed, and a full disk or an unwritable
   * ~/.brevi must cost the run its memories, never its pull request.
   */
  #enqueue(task: () => Promise<void>): Promise<void> {
    this.#io = this.#io.then(task, task).catch((error: unknown) => {
      console.error(`[brevi] memory store write failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return this.#io;
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
