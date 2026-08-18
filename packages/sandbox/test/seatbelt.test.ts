import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { seatbeltPolicy } from "../src/seatbelt/policy.js";
import { SeatbeltProvider, seatbeltAvailable, wrapInSeatbelt } from "../src/seatbelt/provider.js";

const darwin = process.platform === "darwin";

describe("seatbeltPolicy", () => {
  test("walls off the credential trees and re-allows only the run root", () => {
    const policy = seatbeltPolicy({
      rootDir: "/Users/op/.brevi/workspaces/run-1",
      userHome: "/Users/op",
      breviHome: "/Users/op/.brevi",
    });
    expect(policy).toContain("(deny default)");
    expect(policy).toContain('(deny file-read* (subpath "/Users/op/.brevi"))');
    expect(policy).toContain('(allow file-read* (subpath "/Users/op/.brevi/workspaces/run-1"))');
    expect(policy).toContain('(allow file-write* (subpath "/Users/op/.brevi/workspaces/run-1"))');
    expect(policy).toContain('/Users/op/.ssh');
    expect(policy).toContain('/Users/op/.claude');
    expect(policy).toContain('/Users/op/.codex');
    expect(policy).toContain('/Users/op/.azure');
    expect(policy).toContain('/Users/op/.vault-token');
    expect(policy).toContain('/Users/op/.zsh_history');
    expect(policy).toContain('/Users/op/Library/Application Support/Firefox');
    expect(policy).toContain('/Users/op/Library/Application Support/Google/Chrome');
    expect(policy).toContain('/Users/op/Library/Containers/com.apple.Safari');
    // The pasteboard service is denied back out of the broad mach-lookup allow.
    expect(policy).toContain('com.apple.pboard');
    expect(policy.indexOf('(allow mach-lookup)')).toBeLessThan(policy.indexOf('(deny mach-lookup'));
    // Outbound is IP + the resolver socket only; no blanket unix-domain
    // outbound, so the SSH-agent socket is unreachable.
    expect(policy).not.toContain('(allow network-outbound)\n');
    expect(policy).toContain('(remote ip "*:*")');
    expect(policy).toContain('/var/run/mDNSResponder');
    expect(policy).toContain('/Users/op/Library/Keychains');
    // The deny rules land after the broad read allow, so they win in SBPL.
    expect(policy.indexOf("(allow file-read*)")).toBeLessThan(policy.indexOf('(deny file-read* (subpath'));
  });

  test("escapes quotes and backslashes in paths", () => {
    const policy = seatbeltPolicy({
      rootDir: '/tmp/we"ird',
      userHome: "/Users/op",
      breviHome: "/Users/op/.brevi",
    });
    expect(policy).toContain('(subpath "/tmp/we\\"ird")');
  });
});

describe("wrapInSeatbelt", () => {
  test("builds a sandbox-exec argv with a cwd trampoline", () => {
    const launch = wrapInSeatbelt("/tmp/p.sb", "claude", ["-p", "hi"], "/tmp/run/workspace", {
      HOME: "/tmp/run/home",
    });
    expect(launch.file).toBe("/usr/bin/sandbox-exec");
    expect(launch.args.slice(0, 2)).toEqual(["-f", "/tmp/p.sb"]);
    expect(launch.args).toContain("/tmp/run/workspace");
    expect(launch.args.slice(-3)).toEqual(["claude", "-p", "hi"]);
  });
});

describe.if(darwin)("SeatbeltProvider on macOS", () => {
  test("probe passes on a healthy Mac", async () => {
    expect(await seatbeltAvailable()).toBe(true);
  }, 30_000);

  test("execs inside the workspace, denies writes and secret reads outside it", async () => {
    const provider = new SeatbeltProvider();
    const id = `seatbelt-test-${Date.now()}`;
    const sandbox = await provider.create({ id });
    try {
      const inside = await sandbox.exec("/bin/sh", ["-c", "echo hello > out.txt && cat out.txt"]);
      expect(inside.exitCode).toBe(0);
      expect(inside.stdout.trim()).toBe("hello");
      expect(await sandbox.readFile("out.txt")).toBe("hello\n");

      // ~/.brevi outside the run root: writes are denied (tmp domains are
      // deliberately writable, so they can't serve as the deny probe).
      const denied = join(homedir(), ".brevi", `seatbelt-test-denied-${id}`);
      const outsideWrite = await sandbox.exec("/bin/sh", ["-c", `echo pwned > ${JSON.stringify(denied)}`]);
      expect(outsideWrite.exitCode).not.toBe(0);

      // The operator's key material is unreadable.
      const sshRead = await sandbox.exec("/bin/ls", [join(homedir(), ".ssh")]);
      expect(sshRead.exitCode).not.toBe(0);
    } finally {
      await sandbox.destroy();
      await provider.discard(id);
    }
  }, 60_000);

  test("wrap() merges caller env over create-time env and keeps HOME forced", async () => {
    const provider = new SeatbeltProvider();
    const id = `seatbelt-wrap-env-${Date.now()}`;
    const sandbox = await provider.create({ id, env: { CODEX_HOME: "/create-time", KEPT: "yes" } });
    try {
      const launch = sandbox.wrap("true", [], undefined, { env: { CODEX_HOME: "/x" } });
      expect(launch.env.HOME).toBe(sandbox.homePath);
      expect(launch.env.CODEX_HOME).toBe("/x");
      expect(launch.env.KEPT).toBe("yes");
    } finally {
      await sandbox.destroy();
      await provider.discard(id);
    }
  });

  test("reaps a daemonized descendant when the command returns", async () => {
    const provider = new SeatbeltProvider();
    const id = `seatbelt-reap-${Date.now()}`;
    const sandbox = await provider.create({ id });
    const alive = (p) => {
      try {
        process.kill(p, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      // A background sleep that outlives the foreground command. exec must
      // still return promptly (not hang on the inherited pipe), and the
      // daemonized child must be gone once it does.
      const started = Date.now();
      await sandbox.exec("/bin/sh", ["-c", "(sleep 30 & echo $! > bg.pid); sleep 0.2"]);
      expect(Date.now() - started).toBeLessThan(10_000);
      const pid = Number((await sandbox.readFile("bg.pid")).trim());
      expect(Number.isInteger(pid)).toBe(true);
      await new Promise((r) => setTimeout(r, 300));
      expect(alive(pid)).toBe(false);
    } finally {
      await sandbox.destroy();
      await provider.discard(id);
    }
  }, 60_000);
});
