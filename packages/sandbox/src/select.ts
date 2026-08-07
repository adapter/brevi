import type { FirecrackerConfig } from "@brevi/shared";
import { collectFirecrackerPreflightProblems, FirecrackerProvider } from "./firecracker/provider.js";
import { ProcessProvider } from "./process/provider.js";
import type { ProviderSelection, SandboxProvider } from "./types.js";

const SETUP_DOC = "packages/sandbox/README.md";

/**
 * Builds the provider named by the selection. An explicit choice is validated eagerly so
 * misconfiguration fails at startup rather than on the first run; "auto" prefers
 * Firecracker whenever the host passes the full preflight (base checks plus networking:
 * tap devices, IPv4 forwarding) and falls back to the host process.
 */
export async function createSandboxProvider(
  selection: ProviderSelection,
): Promise<SandboxProvider> {
  const concurrency = selection.concurrency ?? 1;

  if (selection.requested === "auto") {
    return (await supportsFirecracker(selection.firecracker, concurrency))
      ? new FirecrackerProvider(selection.firecracker)
      : new ProcessProvider();
  }

  if (selection.requested === "process") {
    const provider = new ProcessProvider();
    await provider.ensureAvailable();
    return provider;
  }

  const problems = await collectFirecrackerPreflightProblems(selection.firecracker, concurrency);
  if (problems.length > 0) {
    const remedy =
      process.platform === "linux"
        ? `Run "brevi setup" to provision this host, or see ${SETUP_DOC} for manual setup.`
        : `See ${SETUP_DOC} for what the firecracker provider needs.`;
    throw new Error(
      `The firecracker sandbox provider cannot run on this host:\n${problems
        .map((problem) => `  - ${problem}`)
        .join("\n")}\n${remedy}`,
    );
  }
  return new FirecrackerProvider(selection.firecracker);
}

async function supportsFirecracker(config: FirecrackerConfig, concurrency: number): Promise<boolean> {
  return (await collectFirecrackerPreflightProblems(config, concurrency)).length === 0;
}
