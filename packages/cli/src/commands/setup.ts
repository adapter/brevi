import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig } from "@brevi/orchestrator";
import {
  collectFirecrackerProblems,
  fileExists,
  isReadWritable,
  resolveBinary,
  SSH_KEY_PATH,
} from "@brevi/sandbox";
import {
  BREVI_HOME,
  CONFIG_PATH,
  firecrackerConfigSchema,
  type BreviConfig,
  type FirecrackerConfig,
} from "@brevi/shared";
import { confirm, intro, log, outro, spinner } from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { errorMessage, exitOnCancel } from "../lib/util.js";

const FIRECRACKER_VERSION = "v1.10.1";
const KERNEL_NAME = "vmlinux-6.1.102";

/** apt package per host tool, for the install hint when one is missing. */
const TOOL_PACKAGES = [
  { tool: "ip", aptPackage: "iproute2" },
  { tool: "ssh", aptPackage: "openssh-client" },
  { tool: "tar", aptPackage: "tar" },
  { tool: "iptables", aptPackage: "iptables" },
  { tool: "docker", aptPackage: "docker.io" },
];

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description(
      "Set up the firecracker sandbox on this host (kvm, binary, kernel, rootfs, network)",
    )
    .action(async () => {
      try {
        await runSetup();
      } catch (err) {
        log.error(errorMessage(err));
        process.exit(1);
      }
    });
}

export interface RunSetupOptions {
  /**
   * False when setup runs inline from `brevi init`, which already drew its own
   * intro/outro frame; setup then logs its result instead of closing the frame.
   */
  standalone?: boolean;
}

/** Runs the setup flow. Resolves to true when the host passes preflight at the end. */
export async function runSetup({ standalone = true }: RunSetupOptions = {}): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(pc.red("✖ brevi setup is interactive and this terminal is not."));
    console.error(pc.dim("  Run it from an interactive terminal."));
    process.exit(1);
  }
  if (process.platform !== "linux") {
    console.error(
      pc.red(
        `✖ brevi setup provisions the firecracker sandbox, which needs KVM and therefore Linux (this host is ${process.platform}).`,
      ),
    );
    console.error(
      pc.dim("  On other platforms brevi uses the process provider; there is nothing to set up."),
    );
    process.exit(1);
  }

  if (standalone) intro(pc.bgCyan(pc.black(" brevi setup ")));

  let config = await loadExisting();
  if (!config) {
    log.info(
      `No config at ${pc.dim(CONFIG_PATH)} yet; provisioning with the default image paths. Run ${pc.cyan("brevi init")} afterwards and it will pick everything up.`,
    );
  }
  let firecracker = config?.sandbox.firecracker ?? firecrackerConfigSchema.parse({});
  const arch = firecrackerArch();

  const missingTools = await checkHostTools();
  const kvmReloginNeeded = await ensureKvmAccess();
  ({ firecracker, config } = await ensureFirecrackerBinary(firecracker, config, arch));
  await ensureKernel(firecracker, arch);
  await ensureRootfs(firecracker, missingTools);
  await ensureNetwork(config, missingTools);

  return verify(firecracker, config, kvmReloginNeeded, standalone);
}

async function loadExisting(): Promise<BreviConfig | undefined> {
  if (!existsSync(CONFIG_PATH)) return undefined;
  try {
    return await loadConfig();
  } catch (err) {
    log.warn(
      `Found a config at ${CONFIG_PATH}, but it could not be parsed: ${errorMessage(err)}. Setup will not touch it.`,
    );
    return undefined;
  }
}

/** Maps the node arch to firecracker's release/CI naming; undefined = no prebuilt release. */
function firecrackerArch(): string | undefined {
  if (process.arch === "x64") return "x86_64";
  if (process.arch === "arm64") return "aarch64";
  return undefined;
}

async function checkHostTools(): Promise<Set<string>> {
  const missing: typeof TOOL_PACKAGES = [];
  for (const entry of TOOL_PACKAGES) {
    if ((await resolveBinary(entry.tool)) === undefined) missing.push(entry);
  }
  if (missing.length === 0) {
    log.success("Host tools: ip, ssh, tar, iptables, and docker are all installed.");
    return new Set();
  }

  const names = new Set(missing.map((entry) => entry.tool));
  const lines = [
    `Missing host tools: ${[...names].join(", ")}. Install them with your package manager, e.g.:`,
    `  ${pc.cyan(`sudo apt install ${missing.map((entry) => entry.aptPackage).join(" ")}`)}`,
  ];
  if (names.has("docker")) lines.push("docker is only needed to build the rootfs image.");
  if (names.has("iptables")) lines.push("iptables is only needed for microVM networking.");
  log.warn(lines.join("\n"));
  return names;
}

/** Resolves to true when a group change was made that needs a re-login to take effect. */
async function ensureKvmAccess(): Promise<boolean> {
  if (await isReadWritable("/dev/kvm")) {
    log.success("/dev/kvm is readable and writable.");
    return false;
  }
  if (!(await fileExists("/dev/kvm"))) {
    log.warn(
      [
        "/dev/kvm does not exist. Load the KVM module for your CPU:",
        `  ${pc.cyan("sudo modprobe kvm_intel")} (Intel) or ${pc.cyan("sudo modprobe kvm_amd")} (AMD)`,
        "If it still does not appear, enable virtualization (VT-x / AMD-V) in the BIOS.",
      ].join("\n"),
    );
    return false;
  }

  const username = userInfo().username;
  const add = exitOnCancel(
    await confirm({
      message: `/dev/kvm exists but is not readable and writable by ${username}. Add ${username} to the "kvm" group?`,
      initialValue: true,
    }),
  );
  if (!add) {
    log.warn("Skipped; brevi cannot boot microVMs until /dev/kvm is readable and writable.");
    return false;
  }
  const code = await runSudo(["usermod", "-aG", "kvm", username]);
  if (code !== 0) {
    log.error(`usermod exited with code ${code}; /dev/kvm access is unchanged.`);
    return false;
  }
  log.warn(
    `Added ${username} to the "kvm" group. Log out and back in (or run ${pc.cyan("newgrp kvm")}) for it to take effect; the rest of setup can proceed regardless.`,
  );
  return true;
}

async function ensureFirecrackerBinary(
  firecracker: FirecrackerConfig,
  config: BreviConfig | undefined,
  arch: string | undefined,
): Promise<{ firecracker: FirecrackerConfig; config: BreviConfig | undefined }> {
  const resolved = await resolveBinary(firecracker.binary);
  if (resolved !== undefined) {
    log.success(`firecracker binary: ${resolved}${await binaryVersion(resolved)}`);
    return { firecracker, config };
  }
  if (arch === undefined) {
    log.warn(
      `firecracker publishes no prebuilt release for ${process.arch}; install the binary yourself and set sandbox.firecracker.binary.`,
    );
    return { firecracker, config };
  }

  const url = `https://github.com/firecracker-microvm/firecracker/releases/download/${FIRECRACKER_VERSION}/firecracker-${FIRECRACKER_VERSION}-${arch}.tgz`;
  const installPath = join(BREVI_HOME, "bin", "firecracker");
  const s = spinner();
  s.start(`Downloading firecracker ${FIRECRACKER_VERSION} (${arch})`);
  try {
    const tmp = await mkdtemp(join(tmpdir(), "brevi-firecracker-"));
    try {
      const tgz = join(tmp, "firecracker.tgz");
      await downloadToFile(url, tgz);
      s.message("Extracting firecracker");
      await extractTarball(tgz, tmp);
      const extracted = join(
        tmp,
        `release-${FIRECRACKER_VERSION}-${arch}`,
        `firecracker-${FIRECRACKER_VERSION}-${arch}`,
      );
      await mkdir(dirname(installPath), { recursive: true });
      await copyFile(extracted, installPath);
      await chmod(installPath, 0o755);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  } catch (err) {
    s.error(`Could not download firecracker: ${errorMessage(err)}`);
    log.warn(
      `Download it manually from ${url} and put the binary on PATH (or set sandbox.firecracker.binary). Continuing with the remaining steps.`,
    );
    return { firecracker, config };
  }
  s.stop(`Installed firecracker ${FIRECRACKER_VERSION} to ${installPath}`);

  if (config) {
    const saved = await saveConfig({
      ...config,
      sandbox: {
        ...config.sandbox,
        firecracker: { ...config.sandbox.firecracker, binary: installPath },
      },
    });
    log.info(`Set sandbox.firecracker.binary to ${installPath} in ${CONFIG_PATH}.`);
    return { firecracker: saved.sandbox.firecracker, config: saved };
  }
  return { firecracker: { ...firecracker, binary: installPath }, config };
}

async function ensureKernel(
  firecracker: FirecrackerConfig,
  arch: string | undefined,
): Promise<void> {
  if (await fileExists(firecracker.kernelImage)) {
    log.success(`Kernel image: ${firecracker.kernelImage}`);
    return;
  }
  if (arch === undefined) {
    log.warn(
      `The firecracker CI bucket has no prebuilt kernel for ${process.arch}; provide a vmlinux at ${firecracker.kernelImage} yourself.`,
    );
    return;
  }

  const url = `https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.10/${arch}/${KERNEL_NAME}`;
  const s = spinner();
  s.start(`Downloading kernel ${KERNEL_NAME} (${arch})`);
  try {
    await mkdir(dirname(firecracker.kernelImage), { recursive: true });
    let lastMib = -1;
    await downloadToFile(url, firecracker.kernelImage, (bytes) => {
      const mib = Math.floor(bytes / (1024 * 1024));
      if (mib !== lastMib) {
        lastMib = mib;
        s.message(`Downloading kernel ${KERNEL_NAME} (${mib} MiB)`);
      }
    });
  } catch (err) {
    s.error(`Could not download the kernel: ${errorMessage(err)}`);
    log.warn(`Download it manually:\n  curl -fsSL -o ${firecracker.kernelImage} ${url}`);
    return;
  }
  s.stop(`Downloaded kernel to ${firecracker.kernelImage}`);
}

async function ensureRootfs(
  firecracker: FirecrackerConfig,
  missingTools: Set<string>,
): Promise<void> {
  if ((await fileExists(firecracker.rootfs)) && (await fileExists(SSH_KEY_PATH))) {
    log.success(`Rootfs image and ssh key: ${firecracker.rootfs}`);
    return;
  }
  if (missingTools.has("docker")) {
    log.warn(
      "Building the rootfs image needs docker; install it and re-run brevi setup for this step.",
    );
    return;
  }
  const build = exitOnCancel(
    await confirm({
      message:
        "Build the rootfs image now? It is a ~2 GB docker build that takes several minutes.",
      initialValue: true,
    }),
  );
  if (!build) {
    log.warn("Skipped; the firecracker provider cannot boot without a rootfs and ssh key.");
    return;
  }

  const script = shippedScript("build-rootfs.sh");
  if (script === undefined) return;
  const code = await runSudo(["bash", script]);
  if (code !== 0) {
    log.error(`build-rootfs.sh exited with code ${code}; the rootfs may be incomplete.`);
  }
}

async function ensureNetwork(
  config: BreviConfig | undefined,
  missingTools: Set<string>,
): Promise<void> {
  const taps = Math.max(16, config?.sandbox.concurrency ?? 1);
  if (await tapsPresent(taps)) {
    log.success(`Tap devices brevi-tap0..brevi-tap${taps - 1} are present.`);
    return;
  }
  if (missingTools.has("iptables")) {
    log.warn(
      "Setting up microVM networking needs iptables; install it and re-run brevi setup for this step.",
    );
    return;
  }
  const proceed = exitOnCancel(
    await confirm({
      message: `Set up microVM networking now? (${taps} tap devices plus NAT for 172.30.0.0/16)`,
      initialValue: true,
    }),
  );
  if (!proceed) {
    log.warn("Skipped; microVMs will have no network until setup-network.sh runs.");
    return;
  }

  const script = shippedScript("setup-network.sh");
  if (script === undefined) return;
  const code = await runSudo([
    "bash",
    script,
    "--taps",
    String(taps),
    "--user",
    userInfo().username,
  ]);
  if (code !== 0) {
    log.error(`setup-network.sh exited with code ${code}.`);
    return;
  }
  log.info(
    "Tap devices and iptables rules do not persist across reboots; re-run brevi setup after a restart.",
  );
}

async function tapsPresent(taps: number): Promise<boolean> {
  for (let i = 0; i < taps; i++) {
    if (!(await fileExists(`/sys/class/net/brevi-tap${i}`))) return false;
  }
  return true;
}

async function verify(
  firecracker: FirecrackerConfig,
  config: BreviConfig | undefined,
  kvmReloginNeeded: boolean,
  standalone: boolean,
): Promise<boolean> {
  const problems = await collectFirecrackerProblems(firecracker);

  if (problems.length === 0) {
    if (config && config.sandbox.provider === "process") {
      const switchProvider = exitOnCancel(
        await confirm({
          message: `sandbox.provider is "process"; switch it to "firecracker"?`,
          initialValue: true,
        }),
      );
      if (switchProvider) {
        await saveConfig({ ...config, sandbox: { ...config.sandbox, provider: "firecracker" } });
        log.info(`Set sandbox.provider to "firecracker" in ${CONFIG_PATH}.`);
      }
    }
    const message = `Firecracker sandbox is ready. Run ${pc.cyan("brevi start")}.`;
    if (standalone) outro(message);
    else log.success(message);
    return true;
  }

  log.warn(`Not ready yet:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  const onlyKvm =
    kvmReloginNeeded && problems.length === 1 && problems[0]?.startsWith("/dev/kvm") === true;
  const message = onlyKvm
    ? `Almost there: log out and back in (or run ${pc.cyan("newgrp kvm")}) so the kvm group change takes effect, then run ${pc.cyan("brevi start")}.`
    : `Re-run ${pc.cyan("brevi setup")} once the remaining problems are fixed.`;
  if (standalone) outro(message);
  else log.info(message);
  return false;
}

/** Resolves a script bundled next to the CLI entry point (dist/scripts). */
function shippedScript(name: string): string | undefined {
  const path = fileURLToPath(new URL(`./scripts/${name}`, import.meta.url));
  if (!existsSync(path)) {
    log.error(
      `The bundled script ${name} is missing at ${path}; reinstall @brevi/cli (or re-run bun run build in the repo).`,
    );
    return undefined;
  }
  return path;
}

/** Prints the exact command line, then runs it with inherited stdio so sudo can prompt. */
function runSudo(args: string[]): Promise<number> {
  log.step(`Running ${pc.cyan(`sudo ${args.join(" ")}`)}`);
  return new Promise((resolve) => {
    const child = spawn("sudo", args, { stdio: "inherit" });
    child.on("error", (err) => {
      log.error(`Could not run sudo: ${errorMessage(err)}`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function binaryVersion(path: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(path, ["--version"], { timeout: 3_000 }, (err, stdout) => {
      const first = stdout.split("\n", 1)[0]?.trim();
      resolve(err || !first ? "" : ` (${first})`);
    });
  });
}

function extractTarball(tgz: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("tar", ["-xzf", tgz, "-C", dest], (err) => (err ? reject(err) : resolve()));
  });
}

/** Streams a URL to disk via a .partial file, so an aborted download never looks complete. */
async function downloadToFile(
  url: string,
  dest: string,
  onProgress?: (bytes: number) => void,
): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || res.body === null) throw new Error(`GET ${url} failed with HTTP ${res.status}`);

  const partial = `${dest}.partial`;
  const file = createWriteStream(partial);
  let bytes = 0;
  try {
    for await (const chunk of res.body) {
      bytes += chunk.length;
      onProgress?.(bytes);
      if (!file.write(chunk)) await once(file, "drain");
    }
    file.end();
    await finished(file);
  } catch (err) {
    file.destroy();
    await rm(partial, { force: true });
    throw err;
  }
  await rename(partial, dest);
}
