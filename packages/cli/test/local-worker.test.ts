import { describe, expect, it } from "bun:test";
import {
  decideHostExecution,
  HEALTHY_UPTIME_MS,
  INITIAL_RESTART_DELAY_MS,
  MAX_RESTART_DELAY_MS,
  restartBackoff,
} from "../src/lib/local-worker.js";

describe("decideHostExecution", () => {
  it("gives Linux a local worker when bwrap is available", () => {
    expect(decideHostExecution("linux", true)).toEqual({ kind: "local-worker" });
  });

  it("gives Linux a bwrap-unavailable reason when bwrap is missing", () => {
    expect(decideHostExecution("linux", false)).toEqual({ kind: "none", reason: "bwrap-unavailable" });
  });

  it("gives every other platform an unsupported-platform reason", () => {
    expect(decideHostExecution("darwin", true)).toEqual({ kind: "none", reason: "unsupported-platform" });
    expect(decideHostExecution("darwin", false)).toEqual({ kind: "none", reason: "unsupported-platform" });
    expect(decideHostExecution("win32", false)).toEqual({ kind: "none", reason: "unsupported-platform" });
    expect(decideHostExecution("freebsd", true)).toEqual({ kind: "none", reason: "unsupported-platform" });
  });
});

describe("restartBackoff", () => {
  it("waits the current delay for a young crash and doubles the one after", () => {
    expect(restartBackoff(INITIAL_RESTART_DELAY_MS, 0)).toEqual({ delayMs: 1_000, nextDelayMs: 2_000 });
    expect(restartBackoff(2_000, 500)).toEqual({ delayMs: 2_000, nextDelayMs: 4_000 });
    expect(restartBackoff(8_000, 1_000)).toEqual({ delayMs: 8_000, nextDelayMs: 16_000 });
  });

  it("caps the doubling at MAX_RESTART_DELAY_MS", () => {
    expect(restartBackoff(16_000, 0)).toEqual({ delayMs: 16_000, nextDelayMs: 30_000 });
    expect(restartBackoff(30_000, 0)).toEqual({ delayMs: 30_000, nextDelayMs: MAX_RESTART_DELAY_MS });
  });

  it("resets the restart being scheduled, not a later one, after a healthy run", () => {
    expect(restartBackoff(30_000, HEALTHY_UPTIME_MS)).toEqual({
      delayMs: INITIAL_RESTART_DELAY_MS,
      nextDelayMs: 2_000,
    });
    expect(restartBackoff(4_000, HEALTHY_UPTIME_MS + 5_000).delayMs).toBe(INITIAL_RESTART_DELAY_MS);
  });

  it("does not reset a moment before the healthy threshold", () => {
    expect(restartBackoff(4_000, HEALTHY_UPTIME_MS - 1)).toEqual({ delayMs: 4_000, nextDelayMs: 8_000 });
  });
});
