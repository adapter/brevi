import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig } from "@brevi/orchestrator";
import {
  collectFirecrackerNetworkProblems,
  collectFirecrackerProblems,
  ensureSshKeypair,
  fileExists,
  installRootfs,
  isReadWritable,
  locateRootfs,
  resolveBinary,
  resolveFirecrackerBinary,
  rootfsArch,
  SSH_KEY_PATH,
} from "@brevi/sandbox";
import {
  BREVI_HOME,
  CONFIG_DEFAULTS,
  CONFIG_PATH,
  firecrackerConfigSchema,
  DEFAULT_ROOTFS,
  resolveFirecrackerImages,
  type BreviConfig,
  type FirecrackerConfig,
} from "@brevi/shared";
import { confirm, intro, log, outro, spinner } from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { downloadToFile } from "../lib/download.js";
import { errorMessage, exitOnCancel } from "../lib/util.js";
import { readPackageVersion } from "../lib/version.js";

const FIRECRACKER_VERSION = "v1.10.1";
const KERNEL_NAME = "vmlinux-6.1.102";

/** Pinned sha256 digests for the downloads above, per architecture. */
const ARTIFACTS = {
  x86_64: {
    binarySha256: "36112969952b0e34fadcfca769d48a55dc22cbba99af17e02bd0e24fc35adc77",
    kernelSha256: "49ba99a5299444ac59dda2efc3569cc2d58a5d72ea6475a6bfc37aa0bf322e54",
  },
  aarch64: {
    binarySha256: "9e3641071de140979afaac0c52fdc107baeba398bdb5709c12f77ee469207fcd",
    kernelSha256: "bb1f50912d63a8ca5e92d488984875e1177eb9283050ffa592a8cb455cada52d",
  },
} as const;

type FirecrackerArch = keyof typeof ARTIFACTS;

/** apt package per host tool, for the install offer (or hint) when one is missing. */
const TOOL_PACKAGES = [
  { tool: "ip", aptPackage: "iproute2" },
  { tool: "ssh", aptPackage: "openssh-client" },
  { tool: "tar", aptPackage: "tar" },
  { tool: "iptables", aptPackage: "iptables" },
];

/**
 * Docker is deliberately not in TOOL_PACKAGES: the prebuilt rootfs needs none, so
 * installing it up front would push a ~500 MB dependency on hosts that will never
 * build from source, and bundling it into the tools prompt would make declining
 * Docker also decline the tools brevi genuinely requires. It is offered on demand,
 * only once the user has chosen the from-source build.
 */
const DOCKER_PACKAGE = { tool: "docker", aptPackage: "docker.io" };

export function registerSetupCommand(program: Command): void {
  program
    .command("setup", { hidden: true })
    .description(
      "Provision the firecracker sandbox on this Linux host (used by the worker installer and first launch)",
    )
    .option(
      "-y, --yes",
      "answer every prompt with its default-yes and never wait for input (for unattended provisioning)",
    )
    .option(
      "--skip-network",
      "skip microVM network setup entirely; use when it is managed elsewhere (e.g. the Linux worker installer's brevi-network.service unit)",
    )
    .option(
      "--set-provider",
      'set sandbox.provider to "firecracker" once setup succeeds, without asking',
    )
    .action(async (options: { yes?: boolean; skipNetwork?: boolean; setProvider?: boolean }) => {
      try {
        const ready = await runSetup({
          assumeYes: options.yes === true,
          skipNetwork: options.skipNetwork === true,
          setProvider: options.setProvider === true,
        });
        if (!ready) process.exitCode = 1;
      } catch (err) {
        log.error(errorMessage(err));
        process.exit(1);
      }
    });
}

export interface RunSetupOptions {
  /**
   * False when setup runs inline under another frame (the caller already drew
   * intro/outro); setup then logs its result instead of closing the frame.
   */
  standalone?: boolean;
  /**
   * Unattended provisioning (e.g. inside brevi's managed VM, driven over a non-interactive
   * shell): every prompt resolves immediately instead of waiting on stdin, logging the
   * choice it made. No interactive terminal is required in this mode.
   */
  assumeYes?: boolean;
  /**
   * Skips ensureNetwork entirely rather than offering to set it up. microVM
   * networking is managed elsewhere in that case: the Linux worker installer's
   * own brevi-network.service unit, which runs as root and re-runs
   * setup-network.sh on every boot, while setup itself runs as the unprivileged
   * service user.
   */
  skipNetwork?: boolean;
  /**
   * Writes sandbox.provider = "firecracker" once setup has succeeded, instead
   * of asking. The Linux worker installer passes it: the machine it just
   * provisioned exists to boot microVMs, so leaving its config on another
   * provider would enroll a worker that executes every dispatched run
   * unsandboxed.
   */
  setProvider?: boolean;
}

/** Runs the setup flow. Resolves to true when the host passes preflight at the end. */
export async function runSetup({
  standalone = true,
  assumeYes = false,
  skipNetwork = false,
  setProvider = false,
}: RunSetupOptions = {}): Promise<boolean> {
  if (!assumeYes && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    console.error(pc.red("✖ brevi setup is interactive and this terminal is not."));
    console.error(pc.dim("  Run it from an interactive terminal, or pass --yes for unattended provisioning."));
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
      `No config at ${pc.dim(CONFIG_PATH)} yet; provisioning with the default image paths.`,
    );
  }
  let firecracker = config?.sandbox.firecracker ?? firecrackerConfigSchema.parse({});
  const arch = firecrackerArch();

  const missingTools = await checkHostTools(assumeYes);
  const kvmReloginGroup = await ensureKvmAccess(assumeYes);
  ({ firecracker, config } = await ensureFirecrackerBinary(firecracker, config, arch));
  await ensureKernel(firecracker, arch);
  await ensureRootfsImage(firecracker, assumeYes);
  if (skipNetwork) {
    log.info("Skipping microVM network setup; it is managed elsewhere (the installer's brevi-network.service unit).");
  } else {
    await ensureNetwork(config, missingTools, assumeYes);
  }

  return verify(firecracker, config, kvmReloginGroup, standalone, assumeYes, setProvider);
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
function firecrackerArch(): FirecrackerArch | undefined {
  if (process.arch === "x64") return "x86_64";
  if (process.arch === "arm64") return "aarch64";
  return undefined;
}

/**
 * The setup flow's yes/no prompts. With `assumeYes` (unattended provisioning, e.g. inside
 * brevi's managed VM) it answers immediately instead of waiting on stdin, and logs the
 * choice so a transcript from a non-interactive shell still shows what setup decided.
 * Pass `unattended` when the interactive default is not the answer that works without a
 * human (e.g. a from-source build that needs docker): `--yes` then takes the override
 * answer instead of `initialValue`, and logs why.
 */
async function ask(
  options: { message: string; initialValue?: boolean },
  assumeYes: boolean,
  unattended?: { answer: boolean; reason: string },
): Promise<boolean> {
  if (assumeYes) {
    const answer = unattended?.answer ?? options.initialValue ?? true;
    log.step(`${options.message} -> ${answer ? "yes" : "no"} (--yes)`);
    if (unattended !== undefined) log.warn(unattended.reason);
    return answer;
  }
  return exitOnCancel(await confirm(options));
}

async function checkHostTools(assumeYes: boolean): Promise<Set<string>> {
  let missing = await missingHostTools();
  if (missing.length === 0) {
    log.success("Host tools: ip, ssh, tar, and iptables are all installed.");
    return new Set();
  }

  const describe = (): string[] => {
    const names = missing.map((entry) => entry.tool);
    const lines = [`Missing host tools: ${names.join(", ")}.`];
    if (names.includes("iptables")) lines.push("iptables is only needed for microVM networking.");
    return lines;
  };
  const packages = missing.map((entry) => entry.aptPackage);

  if ((await resolveBinary("apt-get")) === undefined) {
    log.warn(
      [
        ...describe(),
        "Install them with your package manager, e.g.:",
        `  ${pc.cyan(`sudo apt install ${packages.join(" ")}`)}`,
      ].join("\n"),
    );
    return new Set(missing.map((entry) => entry.tool));
  }

  log.warn(describe().join("\n"));
  const install = await ask(
    { message: `Install ${packages.join(", ")} with apt now? (uses sudo)`, initialValue: true },
    assumeYes,
  );
  if (!install) {
    log.warn("Skipped; the setup steps that need the missing tools will be skipped too.");
    return new Set(missing.map((entry) => entry.tool));
  }
  const code = await runSudo(["apt-get", "install", "-y", ...packages]);
  if (code !== 0) {
    log.error(
      `apt-get exited with code ${code}; try ${pc.cyan("sudo apt-get update")} first, then re-run brevi setup.`,
    );
  }
  missing = await missingHostTools();
  if (missing.length === 0) log.success("Host tools installed.");
  else log.warn(`Still missing after the install: ${missing.map((entry) => entry.tool).join(", ")}.`);
  return new Set(missing.map((entry) => entry.tool));
}

/**
 * Docker for the from-source rootfs build, resolved at the point of use. Returns
 * false when the build cannot proceed, having already explained why.
 */
async function ensureDocker(assumeYes: boolean): Promise<boolean> {
  if ((await resolveBinary(DOCKER_PACKAGE.tool)) !== undefined) return true;

  if ((await resolveBinary("apt-get")) === undefined) {
    log.warn(
      [
        "Building the rootfs from source needs docker, which is not installed.",
        "Install it with your package manager, e.g.:",
        `  ${pc.cyan(`sudo apt install ${DOCKER_PACKAGE.aptPackage}`)}`,
        "then re-run brevi setup for this step.",
      ].join("\n"),
    );
    return false;
  }

  const install = await ask(
    {
      message: `Building from source needs docker. Install ${DOCKER_PACKAGE.aptPackage} with apt now? (uses sudo)`,
      initialValue: true,
    },
    assumeYes,
    {
      answer: false,
      reason:
        "--yes never installs docker, so the from-source rootfs build cannot proceed unattended. Install docker.io and re-run brevi setup, or use the prebuilt rootfs download instead.",
    },
  );
  if (!install) {
    log.warn("Skipped; the from-source build cannot run without docker.");
    return false;
  }

  const code = await runSudo(["apt-get", "install", "-y", DOCKER_PACKAGE.aptPackage]);
  if (code !== 0) {
    log.error(
      `apt-get exited with code ${code}; try ${pc.cyan("sudo apt-get update")} first, then re-run brevi setup.`,
    );
    return false;
  }
  if ((await resolveBinary(DOCKER_PACKAGE.tool)) === undefined) {
    log.warn("docker is still not on PATH after the install; re-run brevi setup for this step.");
    return false;
  }
  log.success("Installed docker.");
  return true;
}

async function missingHostTools(): Promise<typeof TOOL_PACKAGES> {
  const missing: typeof TOOL_PACKAGES = [];
  for (const entry of TOOL_PACKAGES) {
    if ((await resolveBinary(entry.tool)) === undefined) missing.push(entry);
  }
  return missing;
}

/** Resolves to the group added when a change was made that needs a re-login to take effect. */
async function ensureKvmAccess(assumeYes: boolean): Promise<string | undefined> {
  if (await isReadWritable("/dev/kvm")) {
    log.success("/dev/kvm is readable and writable.");
    return undefined;
  }
  if (!(await fileExists("/dev/kvm"))) {
    log.warn(
      [
        "/dev/kvm does not exist. Load the KVM module for your CPU:",
        `  ${pc.cyan("sudo modprobe kvm_intel")} (Intel) or ${pc.cyan("sudo modprobe kvm_amd")} (AMD)`,
        "If it still does not appear, enable virtualization (VT-x / AMD-V) in the BIOS.",
      ].join("\n"),
    );
    return undefined;
  }

  const username = userInfo().username;
  const group = await kvmGroup();
  if (await userInGroup(username, group)) {
    log.warn(
      `${username} is already in the "${group}" group, but this session has not picked it up yet. Log out and back in (or run ${pc.cyan(`newgrp ${group}`)}).`,
    );
    return group;
  }
  const add = await ask(
    {
      message: `/dev/kvm exists but is not readable and writable by ${username}. Add ${username} to the "${group}" group?`,
      initialValue: true,
    },
    assumeYes,
  );
  if (!add) {
    log.warn("Skipped; brevi cannot boot microVMs until /dev/kvm is readable and writable.");
    return undefined;
  }
  const code = await runSudo(["usermod", "-aG", group, username]);
  if (code !== 0) {
    log.error(`usermod exited with code ${code}; /dev/kvm access is unchanged.`);
    return undefined;
  }
  log.warn(
    `Added ${username} to the "${group}" group. Log out and back in (or run ${pc.cyan(`newgrp ${group}`)}) for it to take effect; the rest of setup can proceed regardless.`,
  );
  return group;
}

/**
 * Whether the group database (not the current session) already lists the user
 * in the group; `id -Gn <user>` re-resolves membership instead of reporting the
 * process credentials, so it sees a usermod from a previous run before re-login.
 */
function userInGroup(username: string, group: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("id", ["-Gn", username], { timeout: 3_000 }, (err, stdout) => {
      resolve(!err && stdout.trim().split(/\s+/).includes(group));
    });
  });
}

/** The group owning /dev/kvm, so the usermod offer matches distros that do not call it "kvm". */
function kvmGroup(): Promise<string> {
  return new Promise((resolve) => {
    execFile("stat", ["-c", "%G", "/dev/kvm"], { timeout: 3_000 }, (err, stdout) => {
      const group = stdout.trim();
      resolve(err || group === "" ? "kvm" : group);
    });
  });
}

async function ensureFirecrackerBinary(
  firecracker: FirecrackerConfig,
  config: BreviConfig | undefined,
  arch: FirecrackerArch | undefined,
): Promise<{ firecracker: FirecrackerConfig; config: BreviConfig | undefined }> {
  const resolved = await resolveFirecrackerBinary(firecracker.binary);
  if (resolved !== undefined) {
    const version = await binaryVersion(resolved);
    log.success(`firecracker binary: ${resolved}${version}`);
    if (version === "") {
      log.warn(
        `${resolved} could not report a version; it may be broken or built for the wrong architecture.`,
      );
    }
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
      await downloadToFile(url, tgz, ARTIFACTS[arch].binarySha256);
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
  arch: FirecrackerArch | undefined,
): Promise<void> {
  const kernelImage = resolveFirecrackerImages(firecracker).kernelImage;
  if (await fileExists(kernelImage)) {
    log.success(`Kernel image: ${kernelImage}`);
    return;
  }
  if (arch === undefined) {
    log.warn(
      `The firecracker CI bucket has no prebuilt kernel for ${process.arch}; provide a vmlinux at ${kernelImage} yourself.`,
    );
    return;
  }

  const url = `https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.10/${arch}/${KERNEL_NAME}`;
  const s = spinner();
  s.start(`Downloading kernel ${KERNEL_NAME} (${arch})`);
  try {
    await mkdir(dirname(kernelImage), { recursive: true });
    let lastMib = -1;
    await downloadToFile(url, kernelImage, ARTIFACTS[arch].kernelSha256, (bytes) => {
      const mib = Math.floor(bytes / (1024 * 1024));
      if (mib !== lastMib) {
        lastMib = mib;
        s.message(`Downloading kernel ${KERNEL_NAME} (${mib} MiB)`);
      }
    });
  } catch (err) {
    s.error(`Could not download the kernel: ${errorMessage(err)}`);
    log.warn(`Download it manually:\n  curl -fsSL -o ${kernelImage} ${url}`);
    return;
  }
  s.stop(`Downloaded kernel to ${kernelImage}`);
}

async function ensureRootfsImage(firecracker: FirecrackerConfig, assumeYes: boolean): Promise<void> {
  // Key handling happens here, up front, regardless of which rootfs path (or none) is
  // found below; the preflight at the end reports a still-missing key as a problem.
  try {
    if (await ensureSshKeypair()) {
      log.info(
        `Generated an ssh keypair at ${SSH_KEY_PATH} (v2 images take the public key at boot, nothing is baked in).`,
      );
    }
  } catch (err) {
    log.error(errorMessage(err));
  }

  // locateRootfs reports a present-but-unusable image (empty, corrupt, stale manifest)
  // as a problem rather than a hit, so setup cannot keep calling a rootfs fine while
  // the preflight keeps failing it.
  const cliVersion = readPackageVersion();
  const located = await locateRootfs(firecracker, { cliVersion });
  if (located.path !== undefined) {
    const suffix = located.source === "cache" ? " (downloaded, cached per version)" : "";
    log.success(`Rootfs image: ${located.path}${suffix}`);
    return;
  }
  log.warn(located.problems.join("; "));

  // An explicitly configured path is the user's to supply: brevi never downloads over
  // it, and build-rootfs.sh only ever writes the managed default.
  if (firecracker.rootfs !== "") {
    log.warn(
      `sandbox.firecracker.rootfs is set to ${firecracker.rootfs}, so brevi neither downloads nor builds over it; provide that image yourself, or clear the setting to use the managed one at ${DEFAULT_ROOTFS}.`,
    );
    return;
  }

  // Offer the download first: no docker required, and it is the fast path for
  // almost every host. The from-source build below is the fallback.
  if (rootfsArch() === undefined) {
    log.warn(`No prebuilt rootfs image is published for ${process.arch}.`);
  } else {
    const download = await ask(
      {
        message: `Download the prebuilt rootfs image for brevi ${cliVersion} (~1.5 GB, sha256-verified, no Docker needed)?`,
        initialValue: true,
      },
      assumeYes,
    );
    if (download) {
      const s = spinner();
      s.start(`Downloading rootfs for brevi ${cliVersion}`);
      let lastMib = -1;
      try {
        const path = await installRootfs({
          cliVersion,
          baseUrl: firecracker.rootfsBaseUrl,
          onProgress: (bytes, totalBytes) => {
            const mib = Math.floor(bytes / (1024 * 1024));
            if (mib !== lastMib) {
              lastMib = mib;
              const total = totalBytes !== undefined ? ` of ${Math.floor(totalBytes / (1024 * 1024))}` : "";
              s.message(`Downloading rootfs for brevi ${cliVersion} (${mib}${total} MiB)`);
            }
          },
        });
        s.stop(`Installed rootfs image to ${path}`);
        return;
      } catch (err) {
        s.error(`Could not download the rootfs image: ${errorMessage(err)}`);
        log.warn("Retry brevi setup to try the download again, or build the image from source below.");
      }
    }
  }

  const build = await ask(
    {
      message:
        "Build the rootfs image from source now? It is a ~2 GB docker build that takes several minutes.",
      initialValue: true,
    },
    assumeYes,
    {
      answer: false,
      reason:
        "--yes skips the from-source rootfs build (it needs docker); build it manually with the bundled build-rootfs.sh, or re-run brevi setup interactively once network access allows the prebuilt download.",
    },
  );
  if (!build) {
    log.warn("Skipped; the firecracker provider cannot boot without a rootfs image.");
    return;
  }
  if (!(await ensureDocker(assumeYes))) return;

  const script = shippedScript("build-rootfs.sh");
  if (script === undefined) return;
  const code = await runSudo(["bash", script, "--brevi-home", BREVI_HOME]);
  if (code !== 0) {
    log.error(`build-rootfs.sh exited with code ${code}; the rootfs may be incomplete.`);
  }
}

async function ensureNetwork(
  config: BreviConfig | undefined,
  missingTools: Set<string>,
  assumeYes: boolean,
): Promise<void> {
  const taps = Math.max(16, config?.sandbox.concurrency ?? 1);
  if ((await collectFirecrackerNetworkProblems(taps)).length === 0) {
    log.success(
      `Tap devices brevi-tap0..brevi-tap${taps - 1} are present and IPv4 forwarding is on.`,
    );
    log.info(
      "NAT rules cannot be verified without root; if guests lack egress, re-run setup-network.sh.",
    );
    return;
  }
  if (missingTools.has("iptables")) {
    log.warn(
      "Setting up microVM networking needs iptables; install it and re-run brevi setup for this step.",
    );
    return;
  }
  const proceed = await ask(
    {
      message: `Set up microVM networking now? (${taps} tap devices plus NAT for 172.30.0.0/16)`,
      initialValue: true,
    },
    assumeYes,
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

async function verify(
  firecracker: FirecrackerConfig,
  config: BreviConfig | undefined,
  kvmReloginGroup: string | undefined,
  standalone: boolean,
  assumeYes: boolean,
  setProvider: boolean,
): Promise<boolean> {
  const taps = Math.max(16, config?.sandbox.concurrency ?? 1);
  const problems = [
    ...(await collectFirecrackerProblems(firecracker, readPackageVersion())),
    ...(await collectFirecrackerNetworkProblems(taps)),
  ];

  if (problems.length === 0) {
    if (setProvider) {
      // --set-provider decides outright, and from schema defaults when there is no
      // config at all: the Linux worker installer runs this as a freshly created
      // service user whose home is empty, and the default provider ("auto") silently
      // falls back to the process provider whenever a firecracker preflight fails,
      // which on that machine would mean running dispatched runs unsandboxed. The
      // provisioned firecracker settings ride along, since the pinned binary this run
      // installed under ~/.brevi/bin exists only in memory until something saves it.
      const base = config ?? CONFIG_DEFAULTS;
      if (
        config === undefined ||
        base.sandbox.provider !== "firecracker" ||
        base.sandbox.firecracker.binary !== firecracker.binary
      ) {
        await saveConfig({ ...base, sandbox: { ...base.sandbox, provider: "firecracker", firecracker } });
        log.info(`Set sandbox.provider to "firecracker" in ${CONFIG_PATH} (firecracker binary: ${firecracker.binary}).`);
      }
    } else if (config && config.sandbox.provider === "process") {
      const switchProvider = await ask(
        { message: `sandbox.provider is "process"; switch it to "firecracker"?`, initialValue: true },
        assumeYes,
      );
      if (switchProvider) {
        await saveConfig({ ...config, sandbox: { ...config.sandbox, provider: "firecracker" } });
        log.info(`Set sandbox.provider to "firecracker" in ${CONFIG_PATH}.`);
      }
    }
    if (standalone) outro(`Firecracker sandbox is ready. Run ${pc.cyan("brevi start")}.`);
    else log.success("Firecracker sandbox is ready.");
    return true;
  }

  log.warn(`Not ready yet:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  const onlyKvm =
    kvmReloginGroup !== undefined &&
    problems.length === 1 &&
    problems[0]?.startsWith("/dev/kvm") === true;
  const message = onlyKvm
    ? `Almost there: log out and back in (or run ${pc.cyan(`newgrp ${kvmReloginGroup}`)}) so the ${kvmReloginGroup} group change takes effect, then run ${pc.cyan("brevi start")}.`
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
