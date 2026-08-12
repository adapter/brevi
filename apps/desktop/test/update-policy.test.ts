import { describe, expect, test } from "bun:test";
import {
  shouldInstallNow,
  updateAction,
  updateLine,
  updateMenuItem,
  updateSupport,
  type UpdaterState,
} from "../src/main/update-policy.js";

describe("updateSupport", () => {
  test("development builds are never supported, regardless of platform", () => {
    expect(updateSupport({ platform: "darwin", packaged: false, appImage: false })).toEqual({
      supported: false,
      reason: "disabled in development builds",
    });
  });

  test("macOS is supported once packaged", () => {
    expect(updateSupport({ platform: "darwin", packaged: true, appImage: false })).toEqual({ supported: true });
  });

  test("Linux AppImage is supported", () => {
    expect(updateSupport({ platform: "linux", packaged: true, appImage: true })).toEqual({ supported: true });
  });

  test("Linux without AppImage is left to the package manager", () => {
    expect(updateSupport({ platform: "linux", packaged: true, appImage: false })).toEqual({
      supported: false,
      reason: "managed by your package manager (deb/rpm)",
    });
  });

  test("any other platform is unsupported by name", () => {
    expect(updateSupport({ platform: "win32", packaged: true, appImage: false })).toEqual({
      supported: false,
      reason: "unsupported on win32",
    });
  });
});

describe("updateLine", () => {
  test("unsupported names the reason", () => {
    expect(updateLine({ kind: "unsupported", reason: "disabled in development builds" })).toBe(
      "Updates: disabled in development builds",
    );
  });

  test("idle shows nothing", () => {
    expect(updateLine({ kind: "idle" })).toBeNull();
    expect(updateLine({ kind: "idle", lastCheckedAt: Date.now() })).toBeNull();
  });

  test("checking", () => {
    expect(updateLine({ kind: "checking" })).toBe("Update: checking...");
  });

  test("downloading rounds and clamps percent", () => {
    expect(updateLine({ kind: "downloading", version: "1.2.0", percent: 42.4 })).toBe(
      "Update: downloading v1.2.0 (42%)",
    );
    expect(updateLine({ kind: "downloading", version: "1.2.0", percent: 42.6 })).toBe(
      "Update: downloading v1.2.0 (43%)",
    );
    expect(updateLine({ kind: "downloading", version: "1.2.0", percent: -5 })).toBe(
      "Update: downloading v1.2.0 (0%)",
    );
    expect(updateLine({ kind: "downloading", version: "1.2.0", percent: 142 })).toBe(
      "Update: downloading v1.2.0 (100%)",
    );
  });

  test("ready with nothing running: about to restart", () => {
    expect(updateLine({ kind: "ready", version: "1.2.0", busyRuns: 0 })).toBe(
      "Update: v1.2.0 ready, restarting shortly",
    );
  });

  test("ready with one busy run: singular", () => {
    expect(updateLine({ kind: "ready", version: "1.2.0", busyRuns: 1 })).toBe(
      "Update: v1.2.0 ready (waiting for 1 run)",
    );
  });

  test("ready with multiple busy runs: plural", () => {
    expect(updateLine({ kind: "ready", version: "1.2.0", busyRuns: 3 })).toBe(
      "Update: v1.2.0 ready (waiting for 3 runs)",
    );
  });

  test("installing", () => {
    expect(updateLine({ kind: "installing", version: "1.2.0" })).toBe("Update: installing v1.2.0...");
  });

  test("error surfaces the message", () => {
    expect(updateLine({ kind: "error", message: "network unreachable" })).toBe(
      "Update: check failed (network unreachable)",
    );
  });
});

describe("updateMenuItem", () => {
  test("unsupported: disabled", () => {
    expect(updateMenuItem({ kind: "unsupported", reason: "x" })).toEqual({
      label: "Check for Updates",
      enabled: false,
    });
  });

  test("checking: disabled", () => {
    expect(updateMenuItem({ kind: "checking" })).toEqual({ label: "Checking for Updates...", enabled: false });
  });

  test("downloading: disabled, names the version", () => {
    expect(updateMenuItem({ kind: "downloading", version: "1.2.0", percent: 10 })).toEqual({
      label: "Downloading v1.2.0...",
      enabled: false,
    });
  });

  test("ready: enabled, prompts a restart", () => {
    expect(updateMenuItem({ kind: "ready", version: "1.2.0", busyRuns: 0 })).toEqual({
      label: "Restart to Update (v1.2.0)",
      enabled: true,
    });
  });

  test("installing: disabled", () => {
    expect(updateMenuItem({ kind: "installing", version: "1.2.0" })).toEqual({
      label: "Restarting...",
      enabled: false,
    });
  });

  test("idle: enabled, offers a check", () => {
    expect(updateMenuItem({ kind: "idle" })).toEqual({ label: "Check for Updates", enabled: true });
  });

  test("error: enabled, offers a retry", () => {
    expect(updateMenuItem({ kind: "error", message: "boom" })).toEqual({
      label: "Check for Updates",
      enabled: true,
    });
  });
});

describe("updateAction", () => {
  test("ready installs", () => {
    expect(updateAction({ kind: "ready", version: "1.2.0", busyRuns: 0 })).toBe("install");
  });

  test("idle and error check", () => {
    expect(updateAction({ kind: "idle" })).toBe("check");
    expect(updateAction({ kind: "error", message: "boom" })).toBe("check");
  });

  test("everything else is a no-op click", () => {
    const states: UpdaterState[] = [
      { kind: "unsupported", reason: "x" },
      { kind: "checking" },
      { kind: "downloading", version: "1.2.0", percent: 10 },
      { kind: "installing", version: "1.2.0" },
    ];
    for (const state of states) expect(updateAction(state)).toBe("none");
  });
});

describe("shouldInstallNow", () => {
  test("true only when ready and nothing is running", () => {
    expect(shouldInstallNow({ kind: "ready", version: "1.2.0", busyRuns: 0 }, 0)).toBe(true);
  });

  test("false when ready but a run is executing", () => {
    expect(shouldInstallNow({ kind: "ready", version: "1.2.0", busyRuns: 2 }, 1)).toBe(false);
  });

  test("false when not ready, even with nothing running", () => {
    expect(shouldInstallNow({ kind: "idle" }, 0)).toBe(false);
    expect(shouldInstallNow({ kind: "checking" }, 0)).toBe(false);
  });
});
