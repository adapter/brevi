import { existsSync } from "node:fs";
import { runCommand } from "../exec.js";

const TAP_PREFIX = "brevi-tap";
/** /30 subnets carved out of the private 172.30.0.0/16 range: 64 per third octet. */
const SUBNETS_PER_OCTET = 64;
const MAX_NETWORKS = 256 * SUBNETS_PER_OCTET;
const NETMASK = "255.255.255.252";
const PREFIX_LENGTH = 30;

export interface VmNetwork {
  index: number;
  /** Host-side tap device the microVM's eth0 is attached to. */
  tapDevice: string;
  hostIp: string;
  guestIp: string;
  netmask: string;
  guestMac: string;
}

const claimed = new Set<number>();

/** Reserves the lowest free /30 subnet and tap device name for a new microVM. */
export function allocateNetwork(): VmNetwork {
  for (let index = 0; index < MAX_NETWORKS; index++) {
    if (claimed.has(index)) continue;
    claimed.add(index);
    return describeNetwork(index);
  }
  throw new Error(`no free ${TAP_PREFIX} index available (limit ${MAX_NETWORKS})`);
}

export function releaseNetwork(network: VmNetwork): void {
  claimed.delete(network.index);
}

/**
 * Creates and configures the tap device unless `scripts/setup-network.sh` already
 * provisioned it. Returns true when this process created it and therefore owns cleanup.
 */
export async function ensureTapDevice(network: VmNetwork): Promise<boolean> {
  if (existsSync(`/sys/class/net/${network.tapDevice}`)) return false;
  await ip(["tuntap", "add", "dev", network.tapDevice, "mode", "tap"], network);
  try {
    await ip(["addr", "add", `${network.hostIp}/${PREFIX_LENGTH}`, "dev", network.tapDevice], network);
    await ip(["link", "set", "dev", network.tapDevice, "up"], network);
  } catch (error) {
    await deleteTapDevice(network);
    throw error;
  }
  return true;
}

/** Best-effort teardown; a device that is already gone is not an error. */
export async function deleteTapDevice(network: VmNetwork): Promise<void> {
  await runCommand("ip", ["link", "del", network.tapDevice]);
}

function describeNetwork(index: number): VmNetwork {
  const third = Math.floor(index / SUBNETS_PER_OCTET);
  const base = (index % SUBNETS_PER_OCTET) * 4;
  return {
    index,
    tapDevice: `${TAP_PREFIX}${index}`,
    hostIp: `172.30.${third}.${base + 1}`,
    guestIp: `172.30.${third}.${base + 2}`,
    netmask: NETMASK,
    // Locally administered unicast MAC derived from the subnet, so it is stable per index.
    guestMac: `02:fc:00:00:${hex(third)}:${hex(base + 2)}`,
  };
}

function hex(value: number): string {
  return value.toString(16).padStart(2, "0");
}

async function ip(args: string[], network: VmNetwork): Promise<void> {
  const result = await runCommand("ip", args);
  if (result.exitCode === 0) return;

  const detail = result.stderr.trim() || result.stdout.trim();
  if (/not permitted|permission denied/i.test(detail)) {
    throw new Error(
      `Creating the tap device ${network.tapDevice} requires root privileges ` +
        `(ip ${args.join(" ")}: ${detail}).\n` +
        "brevi does not escalate on its own. Run the one-time host setup, which enables NAT " +
        "and pre-creates a pool of tap devices this process can use unprivileged:\n" +
        "  sudo packages/sandbox/scripts/setup-network.sh --taps 8 --user \"$(whoami)\"\n" +
        "See packages/sandbox/README.md.",
    );
  }
  throw new Error(`ip ${args.join(" ")} failed (exit ${result.exitCode}): ${detail}`);
}
