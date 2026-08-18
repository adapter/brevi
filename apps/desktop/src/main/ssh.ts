import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import type { WorkerProvisionRequest, WorkerProvisionResponse } from "@brevi/shared";

const SSH_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_CHARS = 40_000;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function validate(request: WorkerProvisionRequest): Required<Pick<WorkerProvisionRequest, "host" | "port" | "user">> & WorkerProvisionRequest {
  const host = request.host.trim();
  const user = request.user.trim();
  const port = request.port ?? 22;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(host)) throw new Error("SSH host is invalid");
  if (!/^[A-Za-z_][A-Za-z0-9._-]*$/.test(user)) throw new Error("SSH user is invalid");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SSH port must be between 1 and 65535");
  if (request.identityFile && !isAbsolute(request.identityFile)) throw new Error("SSH identity file must be an absolute path");
  if (request.name && !/^[A-Za-z0-9._@:+ -]+$/.test(request.name)) throw new Error("Worker name contains unsupported characters");
  if (request.concurrency !== undefined && (!Number.isInteger(request.concurrency) || request.concurrency < 1 || request.concurrency > 16)) {
    throw new Error("Worker concurrency must be between 1 and 16");
  }
  return { ...request, host, user, port };
}

type ValidatedRequest = Required<Pick<WorkerProvisionRequest, "host" | "port" | "user">> & WorkerProvisionRequest;
type SshRunner = (request: ValidatedRequest, command: string, input?: string) => Promise<string>;

function runSsh(
  request: Required<Pick<WorkerProvisionRequest, "host" | "port" | "user">> & WorkerProvisionRequest,
  command: string,
  input?: string,
): Promise<string> {
  const args = [
    "-p",
    String(request.port),
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
  ];
  if (request.identityFile) args.push("-i", request.identityFile);
  args.push(`${request.user}@${request.host}`, command);

  return new Promise((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const append = (chunk: Buffer): void => {
      output = (output + chunk.toString()).slice(-MAX_OUTPUT_CHARS);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => child.kill("SIGTERM"), SSH_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output.trim());
      else reject(new Error(output.trim() || `ssh exited with code ${code ?? "unknown"}`));
    });
    child.stdin.end(input);
  });
}

/** Provision a worker without ever placing the single-use pairing token in argv or renderer state. */
export async function provisionWorkerOverSsh(
  input: WorkerProvisionRequest & { pairingToken: string; workerHost: string },
  runner: SshRunner = runSsh,
): Promise<WorkerProvisionResponse> {
  const request = validate(input);
  const tokenPath = `/tmp/brevi-pairing-${randomUUID()}`;
  const quotedTokenPath = shellQuote(tokenPath);
  try {
    await runner(request, `umask 077 && cat > ${quotedTokenPath}`, `${input.pairingToken}\n`);
    const installerArgs = ["--yes", "--host", input.workerHost, "--token-file", tokenPath];
    if (request.name) installerArgs.push("--name", request.name);
    if (request.concurrency !== undefined) installerArgs.push("--concurrency", String(request.concurrency));
    const command = [
      "sudo -n true",
      `curl -fsSL https://brevi.dev/install.sh | sudo -n sh -s -- ${installerArgs.map(shellQuote).join(" ")}`,
    ].join(" && ");
    const output = await runner(request, command);
    return { ok: true, output };
  } finally {
    await runner(request, `rm -f ${quotedTokenPath}`).catch(() => undefined);
  }
}
