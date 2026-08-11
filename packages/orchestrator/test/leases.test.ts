import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LeaseStore, type PersistedLease } from "../src/leases.js";

// Run with `bun test packages/orchestrator` from the repo root. Exercises the
// store on its own, against a real temp file: loading, the immediate vs
// debounced write policy, and flush() as the durability guarantee shutdown
// and tests both rely on.

let dir: string;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function lease(overrides: Partial<PersistedLease> = {}): PersistedLease {
  return {
    id: "lease-1",
    runId: "run-1",
    workerId: "worker-1",
    workerName: "worker one",
    kind: "implementation",
    issuedAt: "2026-08-11T10:00:00.000Z",
    expiresAt: "2026-08-11T10:10:00.000Z",
    appliedSeq: 0,
    ...overrides,
  };
}

describe("LeaseStore", () => {
  it("init on a missing file returns empty and leaves the store empty", async () => {
    dir = await mkdtemp(join(tmpdir(), "brevi-leases-"));
    const store = new LeaseStore(join(dir, "fleet", "leases.json"));
    const loaded = await store.init();
    expect(loaded).toEqual([]);
    expect(store.list()).toEqual([]);
  });

  it("init on a corrupt file returns empty rather than throwing", async () => {
    dir = await mkdtemp(join(tmpdir(), "brevi-leases-"));
    const path = join(dir, "leases.json");
    await writeFile(path, "not json");
    const store = new LeaseStore(path);
    const loaded = await store.init();
    expect(loaded).toEqual([]);
  });

  it("put and delete round-trip through a real file", async () => {
    dir = await mkdtemp(join(tmpdir(), "brevi-leases-"));
    const path = join(dir, "fleet", "leases.json");
    const store = new LeaseStore(path);
    await store.init();

    const entry = lease();
    // A lease the store didn't have yet writes immediately: no flush needed
    // before a fresh LeaseStore pointed at the same file sees it, but we
    // still wait for the write to finish before reading the file directly.
    store.put(entry);
    await store.flush();

    const onDisk = JSON.parse(await readFile(path, "utf8")) as PersistedLease[];
    expect(onDisk).toEqual([entry]);

    const reloaded = new LeaseStore(path);
    expect(await reloaded.init()).toEqual([entry]);

    store.delete(entry.id);
    await store.flush();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual([]);
    expect(store.list()).toEqual([]);
  });

  it("flush() makes a debounced watermark update durable", async () => {
    dir = await mkdtemp(join(tmpdir(), "brevi-leases-"));
    const path = join(dir, "leases.json");
    const store = new LeaseStore(path);
    await store.init();

    const entry = lease();
    store.put(entry);
    await store.flush(); // the creating write; durable before we advance the watermark

    // A put of a lease the store already has only advances appliedSeq here,
    // so it's coalesced behind the debounce rather than written right away.
    store.put({ ...entry, appliedSeq: 5 });
    await store.flush();

    const onDisk = JSON.parse(await readFile(path, "utf8")) as PersistedLease[];
    expect(onDisk).toEqual([{ ...entry, appliedSeq: 5 }]);
  });
});
