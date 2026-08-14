import { BwrapProvider } from "./bwrap/provider.js";
import type { SandboxProvider } from "./types.js";

/**
 * The only sandbox: bubblewrap. Throws when this host cannot run it (not
 * Linux, or bwrap missing / user namespaces disabled). There is no process
 * fallback and no provider switch.
 */
export async function createSandboxProvider(): Promise<SandboxProvider> {
  const provider = new BwrapProvider();
  await provider.ensureAvailable();
  return provider;
}
