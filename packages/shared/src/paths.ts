import { homedir } from "node:os";
import { join } from "node:path";
import type { FirecrackerConfig } from "./config.js";

/**
 * Host paths brevi keeps its state under. Node-only on purpose: the dashboard
 * imports the config schema to validate its forms, and a browser has no home
 * directory to resolve these against. Nothing in `config.ts` may import this
 * module, which is why the image paths below are resolved here at use time
 * rather than baked into the schema as defaults.
 */

/** Root directory for all brevi state: config, run history, artifacts, VM images. */
export const BREVI_HOME = join(homedir(), ".brevi");
export const CONFIG_PATH = join(BREVI_HOME, "config.json");
export const RUNS_DIR = join(BREVI_HOME, "runs");
export const IMAGES_DIR = join(BREVI_HOME, "images");
export const WORKSPACES_DIR = join(BREVI_HOME, "workspaces");
/** Per-repository memories, one JSON file per repo key (see MemoryStore). */
export const MEMORIES_DIR = join(BREVI_HOME, "memories");
/**
 * Enrolled workers on the host: runtime state, not configuration, so it lives
 * beside the run history rather than in config.json (see FleetStore).
 */
export const FLEET_PATH = join(BREVI_HOME, "fleet.json");
/**
 * A worker's own enrollment on its own machine: the id the host assigned it
 * and the credential it earned by redeeming a pairing token. The only fleet
 * secret that touches worker disk, and what makes a reconnect recognisable as
 * the same worker.
 */
export const WORKER_STATE_PATH = join(BREVI_HOME, "worker.json");
/** Directory for log files, e.g. the orchestrator's tee target. */
export const LOGS_DIR = join(BREVI_HOME, "logs");
/** Persistent orchestrator log, tailed by `brevi doctor` as diagnosis evidence. */
export const ORCHESTRATOR_LOG_PATH = join(LOGS_DIR, "orchestrator.log");
/** Written by whichever process runs the server, so the CLI and the desktop app find each other. */
export const SERVER_PID_PATH = join(BREVI_HOME, "server.pid");
/** Fleet state the host keeps across restarts (see the orchestrator's LeaseStore). */
export const FLEET_DIR = join(BREVI_HOME, "fleet");
/** Outstanding run leases, reloaded on boot so a host restart does not lose in-flight runs. */
export const LEASES_PATH = join(FLEET_DIR, "leases.json");

/** Where first-run host provisioning downloads the kernel and `build-rootfs.sh` writes the image. */
export const DEFAULT_KERNEL_IMAGE = join(IMAGES_DIR, "vmlinux");
export const DEFAULT_ROOTFS = join(IMAGES_DIR, "rootfs.ext4");

/**
 * The kernel and rootfs a microVM should boot from. Empty config fields mean
 * "wherever brevi puts them", resolved per use like the size preset in
 * `resolveFirecrackerResources`; a config that names a path keeps it verbatim.
 */
export function resolveFirecrackerImages(config: Pick<FirecrackerConfig, "kernelImage" | "rootfs">): {
  kernelImage: string;
  rootfs: string;
} {
  return {
    kernelImage: config.kernelImage || DEFAULT_KERNEL_IMAGE,
    rootfs: config.rootfs || DEFAULT_ROOTFS,
  };
}
