import { describe, expect, test } from "bun:test";
import { managementAuthorized } from "../src/server.js";

describe("desktop management authorization", () => {
  test("rejects an ordinary browser request", () => {
    expect(managementAuthorized("launch-secret", undefined, null)).toBe(false);
    expect(managementAuthorized("launch-secret", "Bearer wrong", null)).toBe(false);
    expect(managementAuthorized("launch-secret", "launch-secret", null)).toBe(false);
  });

  test("accepts the renderer bearer token and websocket query token", () => {
    expect(managementAuthorized("launch-secret", "Bearer launch-secret", null)).toBe(true);
    expect(managementAuthorized("launch-secret", undefined, "launch-secret")).toBe(true);
  });
});
