import type { FirecrackerConfig } from "@brevi/shared";
import { FirecrackerProvider } from "./firecracker/provider.js";
import { isReadWritable, resolveFirecrackerBinary } from "./host.js";
import { ProcessProvider } from "./process/provider.js";
import type { ProviderSelection, SandboxProvider } from "./types.js";

/**
 * Builds the provider named by the selection. An explicit choice is validated eagerly so
 * misconfiguration fails at startup rather than on the first run; "auto" prefers
 * Firecracker whenever the host can plausibly run it and falls back to the host process.
 */
export async function createSandboxProvider(
  selection: ProviderSelection,
): Promise<SandboxProvider> {
  if (selection.requested === "auto") {
    return (await supportsFirecracker(selection.firecracker))
      ? new FirecrackerProvider(selection.firecracker)
      : new ProcessProvider();
  }

  const provider =
    selection.requested === "firecracker"
      ? new FirecrackerProvider(selection.firecracker)
      : new ProcessProvider();
  await provider.ensureAvailable();
  return provider;
}

async function supportsFirecracker(config: FirecrackerConfig): Promise<boolean> {
  if (process.platform !== "linux") return false;
  if (!(await isReadWritable("/dev/kvm"))) return false;
  return (await resolveFirecrackerBinary(config.binary)) !== undefined;
}
