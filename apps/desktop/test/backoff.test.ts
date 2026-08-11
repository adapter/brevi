import { describe, expect, test } from "bun:test";
import { MAX_RESTART_ATTEMPTS, RESTART_DELAYS_MS, restartDelay } from "../src/main/backoff.js";

describe("restartDelay", () => {
  test("follows the delay table in order", () => {
    for (let attempt = 1; attempt <= RESTART_DELAYS_MS.length; attempt++) {
      expect(restartDelay(attempt)).toBe(RESTART_DELAYS_MS[attempt - 1]);
    }
  });

  test("clamps attempts below 1 to the first delay", () => {
    expect(restartDelay(0)).toBe(RESTART_DELAYS_MS[0]);
    expect(restartDelay(-5)).toBe(RESTART_DELAYS_MS[0]);
  });

  test("repeats the last delay past the end of the table", () => {
    const lastDelay = RESTART_DELAYS_MS[RESTART_DELAYS_MS.length - 1];
    expect(restartDelay(RESTART_DELAYS_MS.length + 1)).toBe(lastDelay);
    expect(restartDelay(MAX_RESTART_ATTEMPTS + 10)).toBe(lastDelay);
  });
});
