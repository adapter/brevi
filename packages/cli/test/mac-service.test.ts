import { describe, expect, it } from "bun:test";
import { parseLimaStatus } from "../src/mac/limactl.js";
import { isEphemeralCliPath, renderLaunchAgent, type LaunchAgentOptions } from "../src/mac/launchd.js";

// Run with `bun test packages/cli` from the repo root. This covers the pure,
// side-effect-free pieces of the mac worker service layer (Lima's JSON status
// output, and the launchd plist rendering); neither spawns `limactl` or
// `launchctl`, so it runs the same on Linux CI as on a Mac. The rest of
// `src/mac/` (preflight, state, templates, idle policy) is covered by
// `mac.test.ts`, which this file deliberately does not touch.

describe("parseLimaStatus", () => {
  it("reads a running instance out of JSON-lines output", () => {
    const output = ['{"name":"brevi","status":"Running"}', '{"name":"other","status":"Stopped"}'].join("\n");
    expect(parseLimaStatus(output, "brevi")).toBe("Running");
    expect(parseLimaStatus(output, "other")).toBe("Stopped");
  });

  it("reads status out of a single JSON array", () => {
    const output = JSON.stringify([
      { name: "brevi", status: "Stopped" },
      { name: "other", status: "Broken" },
    ]);
    expect(parseLimaStatus(output, "brevi")).toBe("Stopped");
    expect(parseLimaStatus(output, "other")).toBe("Broken");
  });

  it("returns Missing for an instance that isn't listed", () => {
    const output = '{"name":"brevi","status":"Running"}';
    expect(parseLimaStatus(output, "nowhere")).toBe("Missing");
  });

  it("returns Missing for empty output", () => {
    expect(parseLimaStatus("", "brevi")).toBe("Missing");
    expect(parseLimaStatus("   \n  \n", "brevi")).toBe("Missing");
  });

  it("never throws on malformed output, returning Missing instead", () => {
    expect(parseLimaStatus("not json at all", "brevi")).toBe("Missing");
    expect(parseLimaStatus("{not: valid json}", "brevi")).toBe("Missing");
    expect(() => parseLimaStatus("{{{{", "brevi")).not.toThrow();
  });

  it("tolerates a mix of malformed and valid lines, using the valid ones", () => {
    const output = ["not json", '{"name":"brevi","status":"Running"}', "", "{broken"].join("\n");
    expect(parseLimaStatus(output, "brevi")).toBe("Running");
  });

  it("distinguishes an instance whose name is a prefix of another's", () => {
    const output = ['{"name":"brevi","status":"Running"}', '{"name":"brevi-2","status":"Stopped"}'].join("\n");
    expect(parseLimaStatus(output, "brevi")).toBe("Running");
    expect(parseLimaStatus(output, "brevi-2")).toBe("Stopped");
    expect(parseLimaStatus(output, "brevi-3")).toBe("Missing");
  });

  it("falls back to Broken for a recognized instance with an unrecognized status", () => {
    const output = '{"name":"brevi","status":"Restarting"}';
    expect(parseLimaStatus(output, "brevi")).toBe("Broken");
  });
});

describe("renderLaunchAgent", () => {
  const options: LaunchAgentOptions = {
    nodePath: "/usr/local/bin/node",
    cliPath: "/usr/local/lib/node_modules/@brevi/cli/dist/index.js",
  };

  it("labels the agent dev.brevi.macvm", () => {
    const plist = renderLaunchAgent(options);
    expect(plist).toContain("<key>Label</key>");
    expect(plist).toContain("<string>dev.brevi.macvm</string>");
  });

  it("sets RunAtLoad and KeepAlive so it starts at login and survives a crash or restart", () => {
    const plist = renderLaunchAgent(options);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
  });

  it("runs `<nodePath> <cliPath> mac supervise` as the program arguments", () => {
    const plist = renderLaunchAgent(options);
    const argsMatch = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist);
    expect(argsMatch).not.toBeNull();
    const args = [...(argsMatch?.[1]?.matchAll(/<string>(.*?)<\/string>/g) ?? [])].map((m) => m[1]);
    expect(args).toEqual([options.nodePath, options.cliPath, "mac", "supervise"]);
  });

  it("points both StandardOutPath and StandardErrorPath at the supervisor log", () => {
    const plist = renderLaunchAgent(options);
    const outMatch = /<key>StandardOutPath<\/key>\s*<string>(.*?)<\/string>/.exec(plist);
    const errMatch = /<key>StandardErrorPath<\/key>\s*<string>(.*?)<\/string>/.exec(plist);
    expect(outMatch?.[1]).toBeTruthy();
    expect(outMatch?.[1]).toBe(errMatch?.[1]);
    expect(outMatch?.[1]).toContain("mac-vm.log");
  });

  it("includes /opt/homebrew/bin in the agent's PATH", () => {
    const plist = renderLaunchAgent(options);
    const pathMatch = /<key>PATH<\/key>\s*<string>(.*?)<\/string>/.exec(plist);
    expect(pathMatch?.[1]).toContain("/opt/homebrew/bin");
    expect(pathMatch?.[1]).toContain("/usr/local/bin");
  });

  it("XML-escapes a path containing & or <", () => {
    const plist = renderLaunchAgent({
      nodePath: "/opt/A & B/<node>",
      cliPath: options.cliPath,
    });
    expect(plist).not.toContain("/opt/A & B/<node>");
    expect(plist).toContain("/opt/A &amp; B/&lt;node&gt;");
  });
});

describe("isEphemeralCliPath", () => {
  it("flags the npx cache, which is what `npx @brevi/cli` actually runs from", () => {
    // The plist is KeepAlive, so a path that npm later evicts does not degrade
    // the supervisor: launchd respawn-fails forever and a stopped VM has
    // nothing left to wake it.
    expect(isEphemeralCliPath("/Users/me/.npm/_npx/2f3a9c/node_modules/@brevi/cli/dist/index.js")).toBe(true);
    expect(isEphemeralCliPath("/Users/me/.npm/_cacache/tmp/abc/dist/index.js")).toBe(true);
  });

  it("flags temp directories, which the OS clears on its own schedule", () => {
    expect(isEphemeralCliPath("/private/var/folders/xy/T/brevi-cli/dist/index.js")).toBe(true);
    expect(isEphemeralCliPath("/tmp/brevi/dist/index.js")).toBe(true);
  });

  it("leaves a real installation where it stands, so upgrading it upgrades the supervisor", () => {
    expect(isEphemeralCliPath("/usr/local/lib/node_modules/@brevi/cli/dist/index.js")).toBe(false);
    expect(isEphemeralCliPath("/opt/homebrew/lib/node_modules/@brevi/cli/dist/index.js")).toBe(false);
    expect(isEphemeralCliPath("/Users/me/code/brevi/packages/cli/dist/index.js")).toBe(false);
    // The managed copy this install makes when the running one is disposable.
    expect(isEphemeralCliPath("/Users/me/.brevi/mac/cli/index.js")).toBe(false);
  });
});
