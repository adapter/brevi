import { bwrapStrategy } from "./bwrap/strategy.js";
import { PlatformSandboxProvider } from "./provider.js";
import { seatbeltStrategy } from "./seatbelt/strategy.js";
import type { SandboxProvider } from "./types.js";

/**
 * The sandbox for this platform: bubblewrap on Linux (namespace isolation),
 * Seatbelt on macOS (policy confinement; the weaker of the two). Throws when
 * the host cannot run its platform's sandbox. There is no process fallback
 * and no cross-platform switch.
 */
export async function createSandboxProvider(): Promise<SandboxProvider> {
  const provider = new PlatformSandboxProvider(
    process.platform === "darwin" ? seatbeltStrategy : bwrapStrategy,
  );
  await provider.ensureAvailable();
  return provider;
}
