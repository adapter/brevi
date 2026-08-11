import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  resolveFirecrackerImages,
  resolveFirecrackerResources,
  type FirecrackerConfig,
} from "@brevi/shared";
import { execa, type ResultPromise } from "execa";
import { runCommand } from "../exec.js";
import { resolveFirecrackerBinary } from "../host.js";
import { FirecrackerApi } from "./api.js";
import { allocateNetwork, deleteTapDevice, ensureTapDevice, releaseNetwork } from "./network.js";
import type { VmNetwork } from "./network.js";
import { ROOTFS_VERSION } from "./rootfs.js";
import { SSH_KEY_PATH } from "./ssh.js";

const SOCKET_WAIT_MS = 10_000;
const SOCKET_POLL_MS = 50;
const STOP_GRACE_MS = 3_000;

export interface MicroVmOptions {
  /** Sandbox id; also used as the Firecracker instance id after sanitisation. */
  id: string;
  /** Per-sandbox directory holding the rootfs copy, API socket, and log. */
  rootDir: string;
  config: FirecrackerConfig;
  /**
   * Image to boot, when a preflight (createSandboxProvider) already resolved one via
   * locateRootfs/ensureRootfs (a downloaded cache image, say); falls back to config.rootfs.
   */
  rootfsImage?: string;
  /** Boot from an existing rootfs.ext4 in rootDir (a retained sandbox disk) instead of copying the base image. */
  reuseRootfs?: boolean;
}

/** A running Firecracker microVM: one process, one tap device, one rootfs copy. */
export class MicroVm {
  readonly network: VmNetwork;
  readonly logPath: string;
  readonly #process: ResultPromise;
  readonly #socketPath: string;
  readonly #ownsTapDevice: boolean;
  #stopped = false;

  constructor(init: {
    network: VmNetwork;
    logPath: string;
    process: ResultPromise;
    socketPath: string;
    ownsTapDevice: boolean;
  }) {
    this.network = init.network;
    this.logPath = init.logPath;
    this.#process = init.process;
    this.#socketPath = init.socketPath;
    this.#ownsTapDevice = init.ownsTapDevice;
  }

  /** Terminates the VM and releases its tap device. Safe to call more than once. */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;

    this.#process.kill("SIGTERM");
    await Promise.race([this.#process, delay(STOP_GRACE_MS)]);
    this.#process.kill("SIGKILL");

    if (this.#ownsTapDevice) await deleteTapDevice(this.network);
    releaseNetwork(this.network);
    await rm(this.#socketPath, { force: true });
  }
}

export async function bootMicroVm(options: MicroVmOptions): Promise<MicroVm> {
  await mkdir(options.rootDir, { recursive: true });

  const rootfsPath = join(options.rootDir, "rootfs.ext4");
  if (options.reuseRootfs) {
    if (!existsSync(rootfsPath)) throw new Error(`no retained rootfs at ${rootfsPath}`);
    assertRetainedRootfsCompatible(rootfsPath, await readSandboxRootfsVersion(options.rootDir));
  } else {
    await copyRootfs(
      options.rootfsImage ?? resolveFirecrackerImages(options.config).rootfs,
      rootfsPath,
    );
    await recordSandboxRootfsVersion(options.rootDir);
  }

  const network = allocateNetwork();
  let ownsTapDevice = false;
  let subprocess: ResultPromise | undefined;

  try {
    ownsTapDevice = await ensureTapDevice(network);

    const socketPath = join(options.rootDir, "firecracker.sock");
    const logPath = join(options.rootDir, "firecracker.log");
    await rm(socketPath, { force: true });
    await writeFile(logPath, "");

    const binary =
      (await resolveFirecrackerBinary(options.config.binary)) ?? options.config.binary;
    subprocess = execa(binary, ["--api-sock", socketPath, "--id", instanceId(options.id)], {
      stdin: "ignore",
      stdout: { file: logPath, append: true },
      stderr: { file: logPath, append: true },
      buffer: false,
      reject: false,
    });

    await waitForSocket(socketPath, subprocess, logPath);
    const authorizedKeys = await readAuthorizedKeysArg();
    await configure(socketPath, options.config, rootfsPath, network, authorizedKeys);

    return new MicroVm({ network, logPath, process: subprocess, socketPath, ownsTapDevice });
  } catch (error) {
    subprocess?.kill("SIGKILL");
    if (ownsTapDevice) await deleteTapDevice(network);
    releaseNetwork(network);
    throw error;
  }
}

/** File beside a sandbox's rootfs copy recording the rootfs contract version it was created from. */
const ROOTFS_VERSION_FILE = "rootfs.version";

/**
 * Written when a sandbox's disk is created, so a retained disk can be checked against the
 * running build's rootfs contract before a rehydrate boots it. Exported for tests.
 */
export async function recordSandboxRootfsVersion(rootDir: string): Promise<void> {
  await writeFile(join(rootDir, ROOTFS_VERSION_FILE), `${ROOTFS_VERSION}\n`);
}

/** The contract version a retained sandbox disk was created from; undefined when unrecorded. Exported for tests. */
export async function readSandboxRootfsVersion(rootDir: string): Promise<number | undefined> {
  try {
    const version = Number((await readFile(join(rootDir, ROOTFS_VERSION_FILE), "utf8")).trim());
    return Number.isInteger(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The retained-disk half of the rootfs version handshake: a disk created from another
 * contract version (or before versions were recorded) must be refused with an actionable
 * error, not booted into an ssh timeout or run under guarantees it does not carry.
 * Exported for tests.
 */
export function assertRetainedRootfsCompatible(rootfsPath: string, created: number | undefined): void {
  if (created === ROOTFS_VERSION) return;
  if (created === undefined) {
    throw new Error(
      `retained sandbox disk ${rootfsPath} records no rootfs version (it was created by an older brevi) and cannot be resumed under rootfs v${ROOTFS_VERSION}; discard the retained sandbox and start a fresh run`,
    );
  }
  if (created < ROOTFS_VERSION) {
    throw new Error(
      `retained sandbox disk ${rootfsPath} was created from rootfs v${created}, but this brevi requires v${ROOTFS_VERSION}; it cannot be resumed: discard the retained sandbox and start a fresh run`,
    );
  }
  throw new Error(
    `retained sandbox disk ${rootfsPath} was created from rootfs v${created}, newer than this brevi understands (v${ROOTFS_VERSION}); update brevi on this machine (brevi update) or discard the retained sandbox`,
  );
}

/**
 * Copy-on-write clone of the base image when the filesystem supports it, so each run
 * gets a writable rootfs without paying for a full copy.
 */
async function copyRootfs(source: string, destination: string): Promise<void> {
  const result = await runCommand("cp", ["--reflink=auto", source, destination]);
  if (result.exitCode === 0) return;
  await copyFile(source, destination);
}

async function configure(
  socketPath: string,
  config: FirecrackerConfig,
  rootfsPath: string,
  network: VmNetwork,
  authorizedKeys: string | undefined,
): Promise<void> {
  const api = new FirecrackerApi(socketPath);
  try {
    // Resolved here, at boot time, so a dashboard size change applies to the
    // next VM (including rehydrated ones for `brevi attach`) without a
    // restart: the provider holds a live reference to this config object.
    const { vcpus, memMib } = resolveFirecrackerResources(config);
    await api.put("/machine-config", { vcpu_count: vcpus, mem_size_mib: memMib });
    await api.put("/boot-source", {
      kernel_image_path: resolveFirecrackerImages(config).kernelImage,
      boot_args: bootArgs(network, authorizedKeys),
    });
    await api.put("/drives/rootfs", {
      drive_id: "rootfs",
      path_on_host: rootfsPath,
      is_root_device: true,
      is_read_only: false,
    });
    await api.put("/network-interfaces/eth0", {
      iface_id: "eth0",
      guest_mac: network.guestMac,
      host_dev_name: network.tapDevice,
    });
    await api.put("/actions", { action_type: "InstanceStart" });
  } finally {
    await api.close();
  }
}

/**
 * Reads the host's ssh public key for boot-time injection into the guest's
 * authorized_keys (see the init script in scripts/build-rootfs.sh), base64-encoded so it
 * survives as a single kernel boot-arg token. Undefined when unreadable: a from-source
 * image still boots and accepts its own baked-in key.
 */
async function readAuthorizedKeysArg(): Promise<string | undefined> {
  try {
    const pubkey = await readFile(`${SSH_KEY_PATH}.pub`, "utf8");
    return Buffer.from(pubkey, "utf8").toString("base64");
  } catch {
    return undefined;
  }
}

/** Kernel `ip=` takes client:server:gateway:netmask:hostname:device:autoconf. */
function bootArgs(network: VmNetwork, authorizedKeys: string | undefined): string {
  const ipConfig = `${network.guestIp}::${network.hostIp}:${network.netmask}::eth0:off`;
  const base = `console=ttyS0 reboot=k panic=1 pci=off ip=${ipConfig}`;
  return authorizedKeys === undefined ? base : `${base} brevi.authorized_keys=${authorizedKeys}`;
}

async function waitForSocket(
  socketPath: string,
  subprocess: ResultPromise,
  logPath: string,
): Promise<void> {
  let exited = false;
  void subprocess.then(
    () => {
      exited = true;
    },
    () => {
      exited = true;
    },
  );

  const deadline = Date.now() + SOCKET_WAIT_MS;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) return;
    if (exited) throw new Error(`firecracker exited before opening its API socket; see ${logPath}`);
    await delay(SOCKET_POLL_MS);
  }
  throw new Error(`firecracker did not open ${socketPath} within ${SOCKET_WAIT_MS}ms; see ${logPath}`);
}

/** Firecracker instance ids allow alphanumerics, dashes and underscores only. */
function instanceId(id: string): string {
  return id.replaceAll(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);
}
