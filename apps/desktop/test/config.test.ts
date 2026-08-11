import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ensureConfig()'s firstLaunch flag (finding 3 from the desktop app review)
// is what decides whether the window lands on /setup or /: it must be true
// only when there was no config file yet and this call just wrote the schema
// defaults, and false on every later call. See helpers/config-probe.ts for
// why this runs in a subprocess with its own $HOME rather than importing
// config.ts directly here.

const here = dirname(fileURLToPath(import.meta.url));
const probeEntry = join(here, "helpers", "config-probe.ts");

interface EnsureResult {
  firstLaunch: boolean;
  provider: string;
}

/** Runs `count` sequential ensureConfig() calls in one subprocess, against a fresh temp $HOME. */
function runProbe(count: number): EnsureResult[] {
  const home = mkdtempSync(join(tmpdir(), "brevi-config-test-"));
  try {
    const ops = Array.from({ length: count }, () => ({ op: "ensure" }));
    const out = execFileSync(process.execPath, [probeEntry], {
      env: { ...process.env, HOME: home, CONFIG_PROBE_OPS: JSON.stringify(ops) },
      encoding: "utf8",
    });
    return JSON.parse(out) as EnsureResult[];
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("ensureConfig", () => {
  test("reports firstLaunch: true and writes schema defaults when no config file exists", () => {
    const [result] = runProbe(1);
    expect(result?.firstLaunch).toBe(true);
    expect(result?.provider).toBe("auto");
  });

  test("reports firstLaunch: false once a config file exists", () => {
    const [first, second] = runProbe(2);
    expect(first?.firstLaunch).toBe(true);
    expect(second?.firstLaunch).toBe(false);
  });
});
