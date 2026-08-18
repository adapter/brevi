import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, migrateConfig, saveConfig } from "../src/config.js";

// Run with `bun test packages/orchestrator` from the repo root. Exercises the
// CONFIG_VERSION migration against a real temp file: a stale stored default
// (pollIntervalSeconds: 60, no stamp) rewrites to the new 15s default and
// gets stamped, while an already-stamped file (even one that kept the old
// literal 60 on purpose) is left byte-for-byte alone.

let dir: string;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("loadConfig migration", () => {
  it("migrates an unstamped pollIntervalSeconds: 60 to 15 and persists the stamp", async () => {
    dir = await mkdtemp(join(tmpdir(), "brevi-config-"));
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({ pollIntervalSeconds: 60 }));

    const config = await loadConfig(path);
    expect(config.pollIntervalSeconds).toBe(15);

    const onDisk = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(onDisk.pollIntervalSeconds).toBe(15);
    expect(onDisk.configVersion).toBe(1);
  });

  it("leaves an already-stamped pollIntervalSeconds: 60 unchanged on disk", async () => {
    dir = await mkdtemp(join(tmpdir(), "brevi-config-"));
    const path = join(dir, "config.json");
    const raw = JSON.stringify({ pollIntervalSeconds: 60, configVersion: 1 });
    await writeFile(path, raw);

    const config = await loadConfig(path);
    expect(config.pollIntervalSeconds).toBe(60);

    const afterLoad = await readFile(path, "utf8");
    expect(afterLoad).toBe(raw);
  });

  it("migrates a non-default pollIntervalSeconds by stamping without touching its value", async () => {
    dir = await mkdtemp(join(tmpdir(), "brevi-config-"));
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({ pollIntervalSeconds: 45 }));

    const config = await loadConfig(path);
    expect(config.pollIntervalSeconds).toBe(45);

    const onDisk = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(onDisk.pollIntervalSeconds).toBe(45);
    expect(onDisk.configVersion).toBe(1);
  });
});

describe("saveConfig", () => {
  it("writes a fresh config stamped current with the 15s default", async () => {
    dir = await mkdtemp(join(tmpdir(), "brevi-config-"));
    const path = join(dir, "config.json");

    const saved = await saveConfig({}, path);
    expect(saved.pollIntervalSeconds).toBe(15);
    expect(saved.configVersion).toBe(1);

    const onDisk = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(onDisk.pollIntervalSeconds).toBe(15);
    expect(onDisk.configVersion).toBe(1);
  });
});

describe("migrateConfig", () => {
  it("returns undefined for a config already stamped current", () => {
    expect(migrateConfig({ pollIntervalSeconds: 60, configVersion: 1 })).toBeUndefined();
  });

  it("returns undefined for non-object input", () => {
    expect(migrateConfig(null)).toBeUndefined();
    expect(migrateConfig(undefined)).toBeUndefined();
    expect(migrateConfig("not an object")).toBeUndefined();
    expect(migrateConfig(42)).toBeUndefined();
    expect(migrateConfig([1, 2, 3])).toBeUndefined();
  });
});
