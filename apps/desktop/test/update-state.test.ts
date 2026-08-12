import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isQuarantined,
  markInstallStarted,
  MAX_INSTALL_ATTEMPTS,
  reconcile,
  readUpdateState,
  writeUpdateState,
  type DesktopUpdateState,
} from "../src/main/update-state.js";

/** Runs `fn` against a fresh temp state file path, cleaning up afterwards. */
function withTempPath(fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "brevi-update-test-"));
  const path = join(dir, "desktop-update.json");
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("readUpdateState", () => {
  test("returns empty state when the file doesn't exist", () => {
    withTempPath((path) => {
      expect(readUpdateState(path)).toEqual({ quarantined: [] });
    });
  });

  test("returns empty state for corrupt JSON", () => {
    withTempPath((path) => {
      writeFileSync(path, "{ not valid json");
      expect(readUpdateState(path)).toEqual({ quarantined: [] });
    });
  });

  test("returns empty state for malformed shapes rather than throwing", () => {
    withTempPath((path) => {
      writeFileSync(path, JSON.stringify({ quarantined: "not-an-array", pending: "not-an-object" }));
      expect(readUpdateState(path)).toEqual({ quarantined: [] });
    });
  });

  test("ignores a quarantined array with non-string entries", () => {
    withTempPath((path) => {
      writeFileSync(path, JSON.stringify({ quarantined: ["1.0.0", 2, null] }));
      expect(readUpdateState(path)).toEqual({ quarantined: [] });
    });
  });

  test("ignores a pending object missing required fields", () => {
    withTempPath((path) => {
      writeFileSync(path, JSON.stringify({ quarantined: [], pending: { version: "1.2.0" } }));
      expect(readUpdateState(path)).toEqual({ quarantined: [] });
    });
  });
});

describe("writeUpdateState / readUpdateState round trip", () => {
  test("round trips a full state", () => {
    withTempPath((path) => {
      const state: DesktopUpdateState = {
        pending: { version: "1.3.0", from: "1.2.0", attempts: 1, startedAt: "2026-08-11T00:00:00.000Z" },
        quarantined: ["1.1.0"],
      };
      writeUpdateState(state, path);
      expect(readUpdateState(path)).toEqual(state);
    });
  });

  test("creates the parent directory if needed", () => {
    const dir = mkdtempSync(join(tmpdir(), "brevi-update-test-"));
    const path = join(dir, "nested", "deeper", "desktop-update.json");
    try {
      writeUpdateState({ quarantined: ["1.0.0"] }, path);
      expect(readUpdateState(path)).toEqual({ quarantined: ["1.0.0"] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("markInstallStarted", () => {
  test("starts a fresh pending install with attempts: 1", () => {
    const state: DesktopUpdateState = { quarantined: [] };
    const next = markInstallStarted(state, "1.0.0", "1.1.0");
    expect(next.pending?.version).toBe("1.1.0");
    expect(next.pending?.from).toBe("1.0.0");
    expect(next.pending?.attempts).toBe(1);
    expect(next.pending?.startedAt).toBeTruthy();
    // Pure: the input is untouched.
    expect(state.pending).toBeUndefined();
  });

  test("bumps attempts and refreshes startedAt on a repeat attempt of the same version", () => {
    const state: DesktopUpdateState = {
      pending: { version: "1.1.0", from: "1.0.0", attempts: 1, startedAt: "2020-01-01T00:00:00.000Z" },
      quarantined: [],
    };
    const next = markInstallStarted(state, "1.0.0", "1.1.0");
    expect(next.pending?.attempts).toBe(2);
    expect(next.pending?.version).toBe("1.1.0");
    expect(next.pending?.from).toBe("1.0.0");
    expect(next.pending?.startedAt).not.toBe("2020-01-01T00:00:00.000Z");
  });

  test("starts a fresh pending install when the target version differs from the existing one", () => {
    const state: DesktopUpdateState = {
      pending: { version: "1.1.0", from: "1.0.0", attempts: 2, startedAt: "2020-01-01T00:00:00.000Z" },
      quarantined: [],
    };
    const next = markInstallStarted(state, "1.1.0", "1.2.0");
    expect(next.pending).toEqual({
      version: "1.2.0",
      from: "1.1.0",
      attempts: 1,
      startedAt: next.pending?.startedAt ?? "",
    });
  });
});

describe("reconcile", () => {
  test("passes state through unchanged when there's no pending install", () => {
    const state: DesktopUpdateState = { quarantined: ["9.9.9"] };
    expect(reconcile(state, "1.0.0")).toEqual({ state });
  });

  test("clears pending on success, no failure reported", () => {
    const state: DesktopUpdateState = {
      pending: { version: "1.1.0", from: "1.0.0", attempts: 1, startedAt: "2026-08-11T00:00:00.000Z" },
      quarantined: ["0.9.0"],
    };
    const result = reconcile(state, "1.1.0");
    expect(result.failed).toBeUndefined();
    expect(result.state).toEqual({ quarantined: ["0.9.0"] });
  });

  test("reports failure and keeps pending below the attempt cap", () => {
    const state: DesktopUpdateState = {
      pending: { version: "1.1.0", from: "1.0.0", attempts: 1, startedAt: "2026-08-11T00:00:00.000Z" },
      quarantined: [],
    };
    const result = reconcile(state, "1.0.0");
    expect(result.failed).toBe("1.1.0");
    expect(result.state.pending).toEqual(state.pending);
    expect(result.state.quarantined).toEqual([]);
  });

  test("quarantines once attempts reaches MAX_INSTALL_ATTEMPTS, and clears pending", () => {
    const state: DesktopUpdateState = {
      pending: { version: "1.1.0", from: "1.0.0", attempts: MAX_INSTALL_ATTEMPTS, startedAt: "2026-08-11T00:00:00.000Z" },
      quarantined: [],
    };
    const result = reconcile(state, "1.0.0");
    expect(result.failed).toBe("1.1.0");
    expect(result.state.pending).toBeUndefined();
    expect(result.state.quarantined).toEqual(["1.1.0"]);
  });

  test("does not duplicate a version already quarantined", () => {
    const state: DesktopUpdateState = {
      pending: { version: "1.1.0", from: "1.0.0", attempts: MAX_INSTALL_ATTEMPTS, startedAt: "2026-08-11T00:00:00.000Z" },
      quarantined: ["1.1.0"],
    };
    const result = reconcile(state, "1.0.0");
    expect(result.state.quarantined).toEqual(["1.1.0"]);
  });
});

describe("isQuarantined", () => {
  test("true for a quarantined version, false otherwise", () => {
    const state: DesktopUpdateState = { quarantined: ["1.1.0"] };
    expect(isQuarantined(state, "1.1.0")).toBe(true);
    expect(isQuarantined(state, "1.2.0")).toBe(false);
  });
});
