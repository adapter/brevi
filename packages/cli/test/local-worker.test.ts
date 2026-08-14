import { describe, expect, it } from "bun:test";
import {
  decideHostExecution,
  HEALTHY_UPTIME_MS,
  INITIAL_RESTART_DELAY_MS,
  MAX_RESTART_DELAY_MS,
  nextRestartDelay,
} from "../src/lib/local-worker.js";

describe("decideHostExecution", () => {
  it("gives Linux a local worker regardless of the mac VM flag", () => {
    expect(decideHostExecution("linux", false)).toEqual({ kind: "local-worker" });
    expect(decideHostExecution("linux", true)).toEqual({ kind: "local-worker" });
  });

  it("gives macOS the managed VM when it is installed", () => {
    expect(decideHostExecution("darwin", true)).toEqual({ kind: "mac-vm" });
  });

  it("gives macOS a not-installed reason when the VM isn't set up", () => {
    expect(decideHostExecution("darwin", false)).toEqual({
      kind: "none",
      reason: "macos-vm-not-installed",
    });
  });

  it("gives every other platform an unsupported-platform reason", () => {
    expect(decideHostExecution("win32", false)).toEqual({ kind: "none", reason: "unsupported-platform" });
    expect(decideHostExecution("win32", true)).toEqual({ kind: "none", reason: "unsupported-platform" });
    expect(decideHostExecution("freebsd", false)).toEqual({ kind: "none", reason: "unsupported-platform" });
  });
});

describe("nextRestartDelay", () => {
  it("doubles the previous delay when the child died young", () => {
    expect(nextRestartDelay(INITIAL_RESTART_DELAY_MS, 0)).toBe(2_000);
    expect(nextRestartDelay(2_000, 500)).toBe(4_000);
    expect(nextRestartDelay(4_000, 1_000)).toBe(8_000);
    expect(nextRestartDelay(8_000, 1_000)).toBe(16_000);
  });

  it("caps the doubling at MAX_RESTART_DELAY_MS", () => {
    expect(nextRestartDelay(16_000, 0)).toBe(30_000);
    expect(nextRestartDelay(30_000, 0)).toBe(30_000);
    expect(nextRestartDelay(1_000_000, 0)).toBe(MAX_RESTART_DELAY_MS);
  });

  it("resets to the initial delay once the child stayed up long enough to count as healthy", () => {
    expect(nextRestartDelay(30_000, HEALTHY_UPTIME_MS)).toBe(INITIAL_RESTART_DELAY_MS);
    expect(nextRestartDelay(4_000, HEALTHY_UPTIME_MS + 5_000)).toBe(INITIAL_RESTART_DELAY_MS);
  });

  it("does not reset a moment before the healthy threshold", () => {
    expect(nextRestartDelay(4_000, HEALTHY_UPTIME_MS - 1)).toBe(8_000);
  });
});
