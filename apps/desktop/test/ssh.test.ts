import { describe, expect, test } from "bun:test";
import { provisionWorkerOverSsh } from "../src/main/ssh.js";

describe("SSH worker provisioning", () => {
  test("keeps the pairing token out of every command", async () => {
    const token = "bwp_super-secret";
    const calls: { command: string; input?: string }[] = [];
    const result = await provisionWorkerOverSsh(
      {
        host: "worker.example.com",
        user: "deploy",
        port: 22,
        pairingToken: token,
        workerHost: "http://10.0.0.2:4410",
        name: "worker one",
        concurrency: 2,
      },
      async (_request, command, input) => {
        calls.push({ command, input });
        return command.includes("install.sh") ? "installed" : "";
      },
    );

    expect(result).toEqual({ ok: true, output: "installed" });
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => !call.command.includes(token))).toBe(true);
    expect(calls[0]?.input).toBe(`${token}\n`);
    expect(calls[1]?.command).toContain("--token-file");
  });

  test("rejects shell metacharacters before invoking ssh", async () => {
    let invoked = false;
    await expect(
      provisionWorkerOverSsh(
        {
          host: "worker;touch-pwned",
          user: "deploy",
          pairingToken: "token",
          workerHost: "http://10.0.0.2:4410",
        },
        async () => {
          invoked = true;
          return "";
        },
      ),
    ).rejects.toThrow("SSH host is invalid");
    expect(invoked).toBe(false);
  });

  test("attempts token cleanup even when the transfer fails", async () => {
    const commands: string[] = [];
    await expect(
      provisionWorkerOverSsh(
        {
          host: "worker.example.com",
          user: "deploy",
          pairingToken: "token",
          workerHost: "http://10.0.0.2:4410",
        },
        async (_request, command) => {
          commands.push(command);
          if (commands.length === 1) throw new Error("connection dropped");
          return "";
        },
      ),
    ).rejects.toThrow("connection dropped");
    expect(commands).toHaveLength(2);
    expect(commands[1]).toContain("rm -f");
  });
});
