import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureConfig, loadConfig } from "../src/config.js";

describe("ensureConfig", () => {
  it("writes schema defaults and reports firstLaunch when the file is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "brevi-config-"));
    try {
      const path = join(dir, "config.json");
      const first = await ensureConfig(path);
      expect(first.firstLaunch).toBe(true);
      expect(first.config.sandbox.provider).toBe("auto");
      const raw = JSON.parse(await readFile(path, "utf8")) as { sandbox: { provider: string } };
      expect(raw.sandbox.provider).toBe("auto");

      const second = await ensureConfig(path);
      expect(second.firstLaunch).toBe(false);
      expect(second.config.sandbox.provider).toBe("auto");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("loadConfig", () => {
  it("points at the CLI when the file is missing", async () => {
    await expect(loadConfig(join(tmpdir(), "brevi-missing-config.json"))).rejects.toThrow(
      "npx @brevi/cli",
    );
  });
});
