import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema, serializeConfig, type BreviConfig } from "@brevi/shared";
import { FleetStore } from "../src/fleet.js";
import { Orchestrator } from "../src/scheduler.js";
import { RunStore } from "../src/state.js";
import { MemoryStore } from "@brevi/integrations";

// Run with `bun test packages/orchestrator` from the repo root (after
// `bun run build`, so the @brevi/shared import resolves to its dist output).
//
// The orchestrator's config is an immutable snapshot: reads go through the
// `config` getter, and every change writes the file first and then swaps the
// whole snapshot. These tests pin down the parts a mutable shared config used
// to provide implicitly: settings updates land on disk and in the snapshot
// together, rejected updates change neither, and old snapshots never move.

let dir: string;
let orchestrator: Orchestrator;
let configPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "brevi-config-"));
  configPath = join(dir, "config.json");
  const config = configSchema.parse({});
  orchestrator = new Orchestrator(
    config,
    new RunStore(join(dir, "runs")),
    configPath,
    new MemoryStore(join(dir, "memories")),
    new FleetStore(join(dir, "fleet.json")),
  );
});

afterEach(async () => {
  await orchestrator.stop();
  await rm(dir, { recursive: true, force: true });
});

describe("config snapshot", () => {
  it("is deeply frozen, so nothing can mutate it by reference", () => {
    expect(Object.isFrozen(orchestrator.config)).toBe(true);
    expect(Object.isFrozen(orchestrator.config.linear)).toBe(true);
    expect(() => {
      (orchestrator.config as { pollIntervalSeconds: number }).pollIntervalSeconds = 1;
    }).toThrow();
  });

  it("applies a settings patch to disk and the snapshot together, swapping rather than mutating", async () => {
    const before = orchestrator.config;
    const events: BreviConfig[] = [];
    orchestrator.on("config", (config) => events.push(config));

    const response = await orchestrator.updateSettings({ pollIntervalSeconds: 120 });

    expect(response.applied).toBe("live");
    expect(orchestrator.config.pollIntervalSeconds).toBe(120);
    // The old snapshot is untouched; the new one is a different object.
    expect(before.pollIntervalSeconds).not.toBe(120);
    expect(orchestrator.config).not.toBe(before);
    // The file is exactly the new snapshot's serialization, which is also
    // what lets the watcher recognize own writes by content.
    expect(await readFile(configPath, "utf8")).toBe(serializeConfig(orchestrator.config));
    expect(events).toHaveLength(1);
    expect(events[0]?.pollIntervalSeconds).toBe(120);
  });

  it("rejects an invalid patch without touching disk or the snapshot", async () => {
    const before = orchestrator.config;
    await expect(orchestrator.updateSettings({ pollIntervalSeconds: -5 })).rejects.toThrow(
      /pollIntervalSeconds/,
    );
    expect(orchestrator.config).toBe(before);
    await expect(readFile(configPath, "utf8")).rejects.toThrow();
  });

  it("rejects a settings patch that would change a secret", async () => {
    await expect(
      orchestrator.updateSettings({ github: { token: "ghp_sneaky" } }),
    ).rejects.toThrow(/github\.token/);
    expect(orchestrator.config.github.token).toBe("");
  });

  it("serializes overlapping updates so neither clobbers the other", async () => {
    const [first, second] = await Promise.all([
      orchestrator.updateSettings({ pollIntervalSeconds: 90 }),
      orchestrator.updateSettings({ trigger: { label: "brevi-2" } }),
    ]);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(orchestrator.config.pollIntervalSeconds).toBe(90);
    expect(orchestrator.config.trigger.label).toBe("brevi-2");
    const onDisk = configSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
    expect(onDisk.pollIntervalSeconds).toBe(90);
    expect(onDisk.trigger.label).toBe("brevi-2");
  });
});
