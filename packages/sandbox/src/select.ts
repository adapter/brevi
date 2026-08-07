import type { FirecrackerConfig } from "@brevi/shared";
import { collectFirecrackerProblems, FirecrackerProvider } from "./firecracker/provider.js";
import { ProcessProvider } from "./process/provider.js";
import type { ProviderSelection, SandboxProvider } from "./types.js";

/**
 * Builds the provider named by the selection. An explicit choice is validated eagerly so
 * misconfiguration fails at startup rather than on the first run; "auto" prefers
 * Firecracker whenever the host passes the full preflight and falls back to the host process.
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
  return (await collectFirecrackerProblems(config)).length === 0;
}
