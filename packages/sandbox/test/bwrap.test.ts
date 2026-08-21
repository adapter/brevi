import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { BREVI_HOME } from "@brevi/shared";
import { SANDBOX_DNS_ADDR, wrapInBwrap } from "../src/bwrap/wrap.js";
import { bwrapStrategy, collectBwrapProblems } from "../src/bwrap/strategy.js";
import { sandboxEnv } from "../src/provider.js";

const ENV = { HOME: "/tmp/run-1/home", TMPDIR: "/tmp", PATH: "/usr/bin:/bin" };
const TOOLS = { bwrap: "/usr/bin/bwrap", pasta: "/usr/bin/pasta" };

/** The bwrap portion of the argv: everything after pasta's `--` separator. */
function bwrapArgs(args: string[]): string[] {
  const dash = args.indexOf("--");
  expect(args[dash + 1]).toBe(TOOLS.bwrap);
  return args.slice(dash + 2);
}

describe("wrapInBwrap", () => {
  test("launches pasta with an isolated netns and no host port mappings", () => {
    const launch = wrapInBwrap(TOOLS, "/tmp/run-1", "claude", ["-p", "hi"], "/tmp/run-1/workspace", {
      env: ENV,
    });
    expect(launch.file).toBe(TOOLS.pasta);
    const pastaPart = launch.args.slice(0, launch.args.indexOf("--"));
    expect(pastaPart).toContain("--config-net");
    expect(pastaPart).toContain("--foreground");
    expect(pastaPart).toContain("--no-map-gw");
    for (const flag of ["-t", "-u", "-T", "-U"]) {
      const at = pastaPart.indexOf(flag);
      expect(at).toBeGreaterThan(-1);
      expect(pastaPart[at + 1]).toBe("none");
    }
    const dnsAt = pastaPart.indexOf("--dns-forward");
    expect(pastaPart[dnsAt + 1]).toBe(SANDBOX_DNS_ADDR);
  });

  test("runs the command after -- and binds the workspace root", () => {
    const env = { ...ENV, ANTHROPIC_API_KEY: "sk-secret-value" };
    const launch = wrapInBwrap(TOOLS, "/tmp/run-1", "claude", ["-p", "hi"], "/tmp/run-1/workspace", {
      env,
    });
    expect(launch.env).toEqual(env);
    const args = bwrapArgs(launch.args);
    expect(args).toContain("--die-with-parent");
    expect(args).toContain("--unshare-user");
    expect(args).not.toContain("--clearenv");
    expect(args).not.toContain("--setenv");
    expect(args).not.toContain("ANTHROPIC_API_KEY");
    expect(args).not.toContain("sk-secret-value");
    expect(args).toContain("--new-session");
    expect(args).toContain("--tmpfs");
    expect(args).toContain("/dev/shm");
    expect(args).toContain("--bind");
    const bindAt = args.indexOf("--bind");
    expect(args[bindAt + 1]).toBe("/tmp/run-1");
    expect(args[bindAt + 2]).toBe("/tmp/run-1");
    const dash = args.lastIndexOf("--");
    expect(args.slice(dash)).toEqual(["--", "claude", "-p", "hi"]);
    expect(args).toContain("--chdir");
    expect(args[args.indexOf("--chdir") + 1]).toBe("/tmp/run-1/workspace");
  });

  test("binds the resolv.conf override over /etc/resolv.conf, but never a symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "brevi-resolv-"));
    try {
      const resolv = join(dir, "resolv.conf");
      writeFileSync(resolv, `nameserver ${SANDBOX_DNS_ADDR}\n`);
      const launch = wrapInBwrap(TOOLS, "/tmp/run-1", "true", [], "/tmp/run-1/workspace", {
        env: ENV,
        resolvConfPath: resolv,
      });
      const args = bwrapArgs(launch.args);
      const at = args.findIndex((arg, i) => arg === "--ro-bind" && args[i + 1] === resolv);
      expect(at).toBeGreaterThan(-1);
      expect(args[at + 2]).toBe("/etc/resolv.conf");

      const link = join(dir, "resolv-link.conf");
      symlinkSync(resolv, link);
      const linked = wrapInBwrap(TOOLS, "/tmp/run-1", "true", [], "/tmp/run-1/workspace", {
        env: ENV,
        resolvConfPath: link,
      });
      expect(bwrapArgs(linked.args)).not.toContain(link);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
        const launch = wrapInBwrap(TOOLS, "/tmp/run-1", "codex", [], "/tmp/run-1/workspace", {
          env: ENV,
        });
        const args = bwrapArgs(launch.args);
        const binds = args.flatMap((arg, i) => (arg === "--ro-bind" || arg === "--bind" ? [args[i + 1]] : []));
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
    const launch = wrapInBwrap(TOOLS, "/tmp/run-1", "true", [], "/tmp/run-1/workspace", {
      newSession: false,
      env: ENV,
    });
    const args = bwrapArgs(launch.args);
    expect(args).not.toContain("--new-session");
    expect(args).not.toContain("--clearenv");
  });

  test("does not bind the operator home or the whole cache tree", () => {
    const home = process.env.HOME ?? "";
    const launch = wrapInBwrap(TOOLS, "/tmp/run-1", "true", [], "/tmp/run-1/workspace", {
      env: ENV,
    });
    const args = bwrapArgs(launch.args);
    const binds = args.flatMap((arg, i) => (arg === "--bind" || arg === "--ro-bind" ? [args[i + 1]] : []));
    if (home && home !== "/tmp/run-1") {
      expect(binds).not.toContain(home);
    }
    expect(binds).not.toContain(`${BREVI_HOME}/cache`);
    expect(binds.filter((path) => path === `${BREVI_HOME}/cache`)).toEqual([]);
  });
});

describe("sandboxEnv", () => {
  test("forces HOME and TMPDIR and drops host secrets", () => {
    const env = sandboxEnv("/tmp/run-1/home", bwrapStrategy.env, { ANTHROPIC_API_KEY: "sk-test" });
    expect(env.HOME).toBe("/tmp/run-1/home");
    expect(env.TMPDIR).toBe("/tmp");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-test");
    expect(env.PLAYWRIGHT_CHROMIUM_SANDBOX).toBe("0");
    expect(env.BREVI_WORKER_CREDENTIAL).toBeUndefined();
  });

  // This is the merge PlatformSandbox.wrap() applies to a caller's `options.env`;
  // exercised directly here because creating a bwrap sandbox needs bwrap/pasta
  // on PATH, which this (macOS) test host does not have.
  test("caller extras from wrap() override create-time env for the same key and keep the rest", () => {
    const env = sandboxEnv(
      "/tmp/run-1/home",
      bwrapStrategy.env,
      { CODEX_HOME: "/create-time", KEPT: "yes" },
      { CODEX_HOME: "/x" },
    );
    expect(env.HOME).toBe("/tmp/run-1/home");
    expect(env.CODEX_HOME).toBe("/x");
    expect(env.KEPT).toBe("yes");
  });
});

describe("collectBwrapProblems", () => {
  test("rejects non-linux hosts without looking for bwrap", async () => {
    if (process.platform === "linux") return;
    const problems = await collectBwrapProblems();
    expect(problems.some((p) => p.includes("need Linux"))).toBe(true);
  });
});
