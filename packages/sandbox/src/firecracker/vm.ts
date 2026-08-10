import { existsSync } from "node:fs";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
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

const SOCKET_WAIT_MS = 10_000;
const SOCKET_POLL_MS = 50;
const STOP_GRACE_MS = 3_000;

export interface MicroVmOptions {
  /** Sandbox id; also used as the Firecracker instance id after sanitisation. */
  id: string;
  /** Per-sandbox directory holding the rootfs copy, API socket, and log. */
  rootDir: string;
  config: FirecrackerConfig;
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
  } else {
    await copyRootfs(resolveFirecrackerImages(options.config).rootfs, rootfsPath);
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
    await configure(socketPath, options.config, rootfsPath, network);

    return new MicroVm({ network, logPath, process: subprocess, socketPath, ownsTapDevice });
  } catch (error) {
    subprocess?.kill("SIGKILL");
    if (ownsTapDevice) await deleteTapDevice(network);
    releaseNetwork(network);
    throw error;
  }
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
      boot_args: bootArgs(network),
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

/** Kernel `ip=` takes client:server:gateway:netmask:hostname:device:autoconf. */
function bootArgs(network: VmNetwork): string {
  const ipConfig = `${network.guestIp}::${network.hostIp}:${network.netmask}::eth0:off`;
  return `console=ttyS0 reboot=k panic=1 pci=off ip=${ipConfig}`;
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
