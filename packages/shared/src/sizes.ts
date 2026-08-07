/**
 * Firecracker VM size presets. Each preset pairs a vCPU count with a memory
 * budget (in MiB): small is 1 vCPU / 3.75 GB, medium is 2 vCPU / 7.5 GB, and
 * large is 4 vCPU / 15 GB. `medium` is the default.
 */
export const FIRECRACKER_SIZES = {
  small: { vcpus: 1, memMib: 3840 },
  medium: { vcpus: 2, memMib: 7680 },
  large: { vcpus: 4, memMib: 15360 },
} as const;

/** A named Firecracker VM size preset, e.g. "small" | "medium" | "large". */
export type FirecrackerVmSize = keyof typeof FIRECRACKER_SIZES;

/**
 * Resolves the vCPU/memory a Firecracker VM should boot with. Explicit
 * `vcpus`/`memMib` overrides win over the size preset. Called at VM boot
 * time so a size change applies to the next boot without a restart.
 */
export function resolveFirecrackerResources(config: {
  size: FirecrackerVmSize;
  vcpus?: number;
  memMib?: number;
}): { vcpus: number; memMib: number } {
  const preset = FIRECRACKER_SIZES[config.size];
  return {
    vcpus: config.vcpus ?? preset.vcpus,
    memMib: config.memMib ?? preset.memMib,
  };
}
