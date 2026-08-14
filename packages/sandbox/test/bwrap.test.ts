import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { BREVI_HOME } from "@brevi/shared";
import { wrapInBwrap } from "../src/bwrap/wrap.js";
import { collectBwrapProblems, sandboxEnv } from "../src/bwrap/provider.js";

const ENV = { HOME: "/tmp/run-1/home", TMPDIR: "/tmp", PATH: "/usr/bin:/bin" };

describe("wrapInBwrap", () => {
  test("runs the command after -- and binds the workspace root", () => {
    const launch = wrapInBwrap("/usr/bin/bwrap", "/tmp/run-1", "claude", ["-p", "hi"], "/tmp/run-1/workspace", {
      env: ENV,
    });
    expect(launch.file).toBe("/usr/bin/bwrap");
    expect(launch.env).toEqual(ENV);
    expect(launch.args).toContain("--die-with-parent");
    expect(launch.args).toContain("--unshare-user");
    expect(launch.args).toContain("--clearenv");
    expect(launch.args).toContain("--new-session");
    expect(launch.args).toContain("--tmpfs");
    expect(launch.args).toContain("/dev/shm");
    expect(launch.args).toContain("--bind");
    const bindAt = launch.args.indexOf("--bind");
    expect(launch.args[bindAt + 1]).toBe("/tmp/run-1");
    expect(launch.args[bindAt + 2]).toBe("/tmp/run-1");
    const dash = launch.args.lastIndexOf("--");
    expect(launch.args.slice(dash)).toEqual(["--", "claude", "-p", "hi"]);
    expect(launch.args).toContain("--chdir");
    expect(launch.args[launch.args.indexOf("--chdir") + 1]).toBe("/tmp/run-1/workspace");
    expect(launch.args).toContain("--setenv");
    expect(launch.args[launch.args.indexOf("--setenv") + 1]).toBe("HOME");
    expect(launch.args[launch.args.indexOf("--setenv") + 2]).toBe("/tmp/run-1/home");
  });

  test("binds a PATH prefix's sibling lib and the resolved package tree", () => {
    const prefix = mkdtempSync(join(tmpdir(), "brevi-bwrap-prefix-"));
    try {
      const bin = join(prefix, "bin");
      const lib = join(prefix, "lib");
      const pkg = join(lib, "node_modules", "@openai", "codex");
      mkdirSync(pkg, { recursive: true });
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(pkg, "package.json"), '{"name":"@openai/codex"}');
      writeFileSync(join(pkg, "cli.js"), "#!/bin/sh\n");
      chmodSync(join(pkg, "cli.js"), 0o755);
      symlinkSync(join(pkg, "cli.js"), join(bin, "codex"));
      const previousPath = process.env.PATH;
      process.env.PATH = `${bin}:/usr/bin:/bin`;
      try {
        const launch = wrapInBwrap("/usr/bin/bwrap", "/tmp/run-1", "codex", [], "/tmp/run-1/workspace", {
          env: ENV,
        });
        const binds = launch.args.flatMap((arg, i) =>
          arg === "--ro-bind" || arg === "--bind" ? [launch.args[i + 1]] : [],
        );
        expect(binds).toContain(lib);
        expect(binds.some((path) => path.endsWith("/lib/node_modules"))).toBe(true);
      } finally {
        process.env.PATH = previousPath;
      }
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });

  test("drops --new-session when attaching to a PTY", () => {
    const launch = wrapInBwrap("/usr/bin/bwrap", "/tmp/run-1", "true", [], "/tmp/run-1/workspace", {
      newSession: false,
      env: ENV,
    });
    expect(launch.args).not.toContain("--new-session");
    expect(launch.args).toContain("--clearenv");
  });

  test("does not bind the operator home or the whole cache tree", () => {
    const home = process.env.HOME ?? "";
    const launch = wrapInBwrap("/usr/bin/bwrap", "/tmp/run-1", "true", [], "/tmp/run-1/workspace", {
      env: ENV,
    });
    const binds = launch.args.flatMap((arg, i) =>
      arg === "--bind" || arg === "--ro-bind" ? [launch.args[i + 1]] : [],
    );
    if (home && home !== "/tmp/run-1") {
      expect(binds).not.toContain(home);
    }
    expect(binds).not.toContain(`${BREVI_HOME}/cache`);
    expect(binds.filter((path) => path === `${BREVI_HOME}/cache`)).toEqual([]);
  });
});

describe("sandboxEnv", () => {
  test("forces HOME and TMPDIR and drops host secrets", () => {
    const env = sandboxEnv("/tmp/run-1/home", { ANTHROPIC_API_KEY: "sk-test" });
    expect(env.HOME).toBe("/tmp/run-1/home");
    expect(env.TMPDIR).toBe("/tmp");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-test");
    expect(env.PLAYWRIGHT_CHROMIUM_SANDBOX).toBe("0");
    expect(env.BREVI_WORKER_CREDENTIAL).toBeUndefined();
  });
});

describe("collectBwrapProblems", () => {
  test("rejects non-linux hosts without looking for bwrap", async () => {
    if (process.platform === "linux") return;
    const problems = await collectBwrapProblems();
    expect(problems.some((p) => p.includes("need Linux"))).toBe(true);
  });
});
