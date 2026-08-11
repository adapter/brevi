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
/** Stable per-machine worker id (a randomUUID), created on first `brevi worker` run. */
export const WORKER_ID_PATH = join(BREVI_HOME, "worker-id");

/** Where `brevi setup` downloads the kernel and `build-rootfs.sh` writes the image. */
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
