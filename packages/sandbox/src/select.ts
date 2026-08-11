import {
  collectFirecrackerBaseProblems,
  collectFirecrackerNetworkProblems,
  collectFirecrackerPreflightProblems,
  collectSshKeyProblems,
  FirecrackerProvider,
} from "./firecracker/provider.js";
import {
  ensureRootfs,
  ensureSshKeypair,
  rootfsHandshakeProblem,
  type RootfsResolution,
} from "./firecracker/rootfs.js";
import { ProcessProvider } from "./process/provider.js";
import type { ProviderSelection, SandboxProvider } from "./types.js";

const SETUP_DOC = "packages/sandbox/README.md";

/**
 * Builds the provider named by the selection. An explicit choice is validated eagerly so
 * misconfiguration fails at startup rather than on the first run; "auto" prefers
 * Firecracker whenever the host passes the full preflight (base checks plus rootfs,
 * ssh key, and networking: tap devices, IPv4 forwarding) and falls back to the host
 * process otherwise. "auto" never fails, it downgrades; the one exception is the rootfs
 * version handshake below, where a dispatching host explicitly required a guest contract
 * this build cannot provide and silently running its work anyway would be wrong.
 */
export async function createSandboxProvider(
  selection: ProviderSelection,
): Promise<SandboxProvider> {
  const concurrency = selection.concurrency ?? 1;
  const log = selection.log ?? ((): void => {});

  // The version handshake comes before everything, the process fallback included: a
  // dispatcher that requires a rootfs contract newer than this build supports must get a
  // refusal naming the fix ("update the worker"), never a silent downgrade.
  if (selection.requiredRootfsVersion !== undefined && selection.requested !== "process") {
    const handshakeProblem = rootfsHandshakeProblem(selection.requiredRootfsVersion);
    if (handshakeProblem !== undefined) throw new Error(handshakeProblem);
  }

  if (selection.requested === "process") {
    const provider = new ProcessProvider();
    await provider.ensureAvailable();
    return provider;
  }

  // Cheap gates first (platform, kvm, binary, host tools, kernel, plus networking: tap
  // devices, IPv4 forwarding): only when these already pass is a rootfs resolution worth
  // attempting, since resolving it may mean downloading a multi-GB image. A host that can
  // never boot a VM (no KVM, wrong OS, missing taps, IPv4 forwarding off, ...) should never
  // trigger that download in auto mode just to find out it doesn't matter.
  const baseProblems = await collectFirecrackerBaseProblems(selection.firecracker);
  const networkProblems = await collectFirecrackerNetworkProblems(concurrency);

  if (baseProblems.length === 0 && networkProblems.length === 0) {
    // ensureRootfs is designed never to throw, but "auto" must survive even an unexpected
    // escape (say, a cache directory whose permissions defeat cleanup): convert it into a
    // problem so auto still downgrades to the process provider instead of aborting startup.
    let rootfs: RootfsResolution & { downloaded?: boolean };
    try {
      rootfs = await ensureRootfs(selection.firecracker, {
        cliVersion: selection.cliVersion,
        download: true,
        log,
      });
    } catch (error) {
      rootfs = {
        problems: [`rootfs resolution failed: ${error instanceof Error ? error.message : String(error)}`],
      };
    }

    // Best-effort: a failure here surfaces as a missing-key problem below, which is
    // reported (and, for "firecracker", thrown) the same way any other missing key is.
    try {
      await ensureSshKeypair();
    } catch (error) {
      log(error instanceof Error ? error.message : String(error));
    }

    const problems = [
      ...baseProblems,
      ...rootfs.problems,
      ...(await collectSshKeyProblems()),
      ...networkProblems,
    ];
    if (problems.length === 0) {
      return new FirecrackerProvider(selection.firecracker, {
        cliVersion: selection.cliVersion,
        log,
      });
    }
    if (selection.requested === "auto") {
      log(
        `firecracker preflight failed, falling back to the process provider:\n${problems
          .map((problem) => `  - ${problem}`)
          .join("\n")}`,
      );
      return new ProcessProvider();
    }
    throw firecrackerUnavailableError(problems);
  }

  if (selection.requested === "auto") return new ProcessProvider();

  // Explicit "firecracker" with failing gates: build the full aggregated error the same
  // way `brevi doctor` would, without ever attempting a download the host can't use.
  const problems = await collectFirecrackerPreflightProblems(
    selection.firecracker,
    concurrency,
    selection.cliVersion,
  );
  throw firecrackerUnavailableError(problems);
}

function firecrackerUnavailableError(problems: string[]): Error {
  const remedy =
    process.platform === "linux"
      ? `Run "brevi setup" to provision this host, or see ${SETUP_DOC} for manual setup.`
      : `See ${SETUP_DOC} for what the firecracker provider needs.`;
  return new Error(
    `The firecracker sandbox provider cannot run on this host:\n${problems
      .map((problem) => `  - ${problem}`)
      .join("\n")}\n${remedy}`,
  );
}
