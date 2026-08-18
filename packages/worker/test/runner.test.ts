import { describe, expect, it } from "bun:test";
import { argvToExtraArgs, definedEnv, detectRateLimitEvent } from "../src/runner.js";

// Run with `bun test packages/worker` from the repo root (after
// `bun run build`, so the @brevi/shared import resolves to its dist output).
// Not part of the tsc build: the package's tsconfig only includes src/.

describe("argvToExtraArgs", () => {
  it("maps a flag/value pair", () => {
    expect(argvToExtraArgs(["--foo", "bar"], () => {})).toEqual({ foo: "bar" });
  });

  it("maps a bare flag to null", () => {
    expect(argvToExtraArgs(["--flag"], () => {})).toEqual({ flag: null });
  });

  it("maps --key=value, a bare flag followed by another flag, and a consumed value", () => {
    expect(argvToExtraArgs(["--a=1", "--b", "--c", "2"], () => {})).toEqual({ a: "1", b: null, c: "2" });
  });

  it("warns once per positional token and skips it", () => {
    const warnings: string[] = [];
    expect(argvToExtraArgs(["x", "--k", "v"], (message) => warnings.push(message))).toEqual({ k: "v" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("x");
  });

  it("returns an empty object for no args", () => {
    expect(argvToExtraArgs([], () => {})).toEqual({});
  });
});

describe("detectRateLimitEvent", () => {
  it("maps a rejected five_hour event with an epoch-seconds resetsAt", () => {
    const resetsAtSeconds = Math.floor(Date.now() / 1000) + 3600;
    const limit = detectRateLimitEvent(
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: resetsAtSeconds },
      },
      "claude",
    );
    expect(limit).toBeDefined();
    expect(limit?.kind).toBe("five-hour");
    expect(limit?.resetsAt).toBe(new Date(resetsAtSeconds * 1000).toISOString());
  });

  it("maps a rejected seven_day* variant to weekly", () => {
    const limit = detectRateLimitEvent(
      { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day_opus" } },
      "claude",
    );
    expect(limit?.kind).toBe("weekly");
  });

  it("ignores allowed and allowed_warning statuses", () => {
    expect(
      detectRateLimitEvent({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } }, "claude"),
    ).toBeUndefined();
    expect(
      detectRateLimitEvent({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } }, "claude"),
    ).toBeUndefined();
  });

  it("ignores non-rate_limit_event shapes", () => {
    expect(detectRateLimitEvent({ type: "assistant" }, "claude")).toBeUndefined();
    expect(detectRateLimitEvent("not an event", "claude")).toBeUndefined();
    expect(detectRateLimitEvent(undefined, "claude")).toBeUndefined();
  });

  it("leaves resetsAt undefined when the event doesn't report one", () => {
    const limit = detectRateLimitEvent(
      { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour" } },
      "claude",
    );
    expect(limit).toBeDefined();
    expect(limit?.resetsAt).toBeUndefined();
  });
});

describe("definedEnv", () => {
  it("drops undefined values", () => {
    expect(definedEnv({ A: "1", B: undefined, C: "3" })).toEqual({ A: "1", C: "3" });
  });
});
