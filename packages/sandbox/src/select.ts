import { BwrapProvider } from "./bwrap/provider.js";
import { SeatbeltProvider } from "./seatbelt/provider.js";
import type { SandboxProvider } from "./types.js";

/**
 * The sandbox for this platform: bubblewrap on Linux (namespace isolation),
 * Seatbelt on macOS (policy confinement; the weaker of the two). Throws when
 * the host cannot run its platform's sandbox. There is no process fallback
 * and no cross-platform switch.
 */
export async function createSandboxProvider(): Promise<SandboxProvider> {
  const provider: SandboxProvider =
    process.platform === "darwin" ? new SeatbeltProvider() : new BwrapProvider();
  await provider.ensureAvailable();
  return provider;
}
