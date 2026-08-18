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
      else {
        const raw = output.trim() || `ssh exited with code ${code ?? "unknown"}`;
        reject(new Error(explainSshFailure(raw, request)));
      }
    });
    child.stdin.end(input);
  });
}

/**
 * Turn the common raw ssh/sudo failures into instructions. Provisioning runs
 * with BatchMode=yes so no password prompt can ever appear; the fixes below
 * are the only ways forward and the raw output alone does not say so.
 */
function explainSshFailure(raw: string, request: ValidatedRequest): string {
  const dest = `${request.user}@${request.host}`;
  if (/permission denied \(.*(publickey|password)/i.test(raw)) {
    const key = request.identityFile ? ` -i ${request.identityFile}` : "";
    return (
      `${dest} did not accept an SSH key, and brevi never sends passwords, so the machine must ` +
      `trust your key first. Run "ssh-copy-id${key} ${dest}" from a terminal (it may ask for the ` +
      `password once), then install again. If the machine only accepts a specific key, set its ` +
      `path in the Identity file field. (${raw.split("\n").pop()})`
    );
  }
  if (/interactive authentication required/i.test(raw)) {
    return (
      `${dest} connected, but elevating to root wanted an interactive prompt (polkit), which ` +
      `brevi cannot answer. Install as root directly (set User to root), or give ${request.user} ` +
      `real passwordless sudo: "echo '${request.user} ALL=(ALL) NOPASSWD:ALL' | sudo tee ` +
      `/etc/sudoers.d/${request.user}" on that machine, then install again.`
    );
  }
  if (/sudo: (a password is required|no tty present)/i.test(raw)) {
    return (
      `${dest} connected, but sudo on that machine asks for a password, which brevi cannot type. ` +
      `Allow passwordless sudo for ${request.user} (for example "echo '${request.user} ` +
      `ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/${request.user}"), then install again.`
    );
  }
  if (/could not resolve hostname/i.test(raw)) {
    return `The host ${request.host} could not be resolved. Check the hostname and try again.`;
  }
  if (/connection refused|connection timed out|operation timed out/i.test(raw)) {
    return `Could not reach ${dest} on port ${request.port}. Check that the machine is up and sshd is listening. (${raw.split("\n").pop()})`;
  }
  return raw;
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
