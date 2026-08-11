import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { resolveCliEntry } from "../src/main/paths.js";

describe("resolveCliEntry", () => {
  // The staged tree mirrors a production npm install, so the entry sits at
  // resources/cli/dist/index.js with the manifest and node_modules above it
  // (see scripts/stage-cli.ts).
  test("packaged: resolves under resourcesPath/cli/dist", () => {
    const entry = resolveCliEntry({
      packaged: true,
      resourcesPath: "/Applications/brevi.app/Contents/Resources",
      here: "/Applications/brevi.app/Contents/Resources/app.asar/dist",
    });
    expect(entry).toBe(
      join("/Applications/brevi.app/Contents/Resources", "cli", "dist", "index.js"),
    );
  });

  test("checkout: resolves the workspace build three levels up from `here`", () => {
    const entry = resolveCliEntry({
      packaged: false,
      resourcesPath: "",
      here: "/repo/apps/desktop/dist",
    });
    expect(entry).toBe(join("/repo", "packages", "cli", "dist", "index.js"));
  });

  test("BREVI_DESKTOP_CLI_ENTRY overrides both packaged and checkout resolution", () => {
    const previous = process.env.BREVI_DESKTOP_CLI_ENTRY;
    process.env.BREVI_DESKTOP_CLI_ENTRY = "/custom/cli/index.js";
    try {
      expect(
        resolveCliEntry({ packaged: true, resourcesPath: "/resources", here: "/anywhere" }),
      ).toBe("/custom/cli/index.js");
      expect(
        resolveCliEntry({ packaged: false, resourcesPath: "", here: "/repo/apps/desktop/dist" }),
      ).toBe("/custom/cli/index.js");
    } finally {
      if (previous === undefined) delete process.env.BREVI_DESKTOP_CLI_ENTRY;
      else process.env.BREVI_DESKTOP_CLI_ENTRY = previous;
    }
  });
});
