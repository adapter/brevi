import { execFile } from "node:child_process";

/**
 * Hardware policy for brevi's macOS worker. Nested virtualization through
 * Virtualization.framework, which is what lets the managed Linux guest see
 * KVM and run the stock firecracker provider, is only exposed on Apple
 * silicon M3 and newer, under macOS 15 and newer. This is a hard gate: older
 * Apple silicon and every Intel Mac are unsupported as workers, with no
 * fallback and no degraded mode, so the policy below either says yes outright
 * or refuses with the concrete reason.
 */

/** Chip generation brevi's macOS worker needs: nested virtualization is M3 and newer only. */
export const MIN_CHIP_GENERATION = 3;
/** macOS release that exposes nested virtualization through Virtualization.framework. */
export const MIN_MACOS_MAJOR = 15;
/** One sentence naming the requirement, printed by every refusal. */
export const MAC_WORKER_REQUIREMENT =
  "The brevi macOS worker requires Apple silicon M3 or newer, running macOS 15 or newer.";

export interface MacHostFacts {
  /** process.platform of the machine being judged. */
  platform: string;
  /** sysctl machdep.cpu.brand_string, e.g. "Apple M3 Pro". Empty when unknown. */
  cpuBrand: string;
  /** sw_vers -productVersion, e.g. "15.3.1". Empty when unknown. */
  productVersion: string;
}

export interface MacHostSupport {
  supported: boolean;
  /** One line per unmet requirement, ready to print. Empty when supported. */
  problems: string[];
  /** Apple chip generation parsed from cpuBrand, when it is an Apple chip. */
  chipGeneration?: number;
  /** Major macOS version parsed from productVersion. */
  macosMajor?: number;
}

/** "Apple M3 Pro" -> 3, "Apple M1" -> 1; undefined for Intel or an unreadable brand string. */
export function parseChipGeneration(cpuBrand: string): number | undefined {
  const match = /\bApple M(\d+)/.exec(cpuBrand);
  if (!match) return undefined;
  const generation = Number(match[1]);
  return Number.isFinite(generation) ? generation : undefined;
}

/** "15.3.1" -> 15; undefined when unparseable. */
export function parseMacosMajor(productVersion: string): number | undefined {
  const match = /^(\d+)(?:\.\d+)*$/.exec(productVersion.trim());
  if (!match) return undefined;
  const major = Number(match[1]);
  return Number.isFinite(major) ? major : undefined;
}

/** The hardware policy, as a pure function of what the machine reports, so it is testable off a Mac. */
export function evaluateMacHostSupport(facts: MacHostFacts): MacHostSupport {
  const problems: string[] = [];

  if (facts.platform !== "darwin") {
    problems.push(
      `This is a ${facts.platform} machine; the brevi macOS worker only runs on macOS.`,
    );
    // Chip and macOS version facts are meaningless off a Mac; report only the
    // platform mismatch rather than parsing garbage into a false chip generation.
    return { supported: false, problems };
  }

  const chipGeneration = parseChipGeneration(facts.cpuBrand);
  if (chipGeneration === undefined) {
    // A brand string that reads as anything other than "Apple M<n>" is an
    // Intel Mac in practice, but an empty one only means the sysctl probe
    // failed, so say which of the two this is rather than accusing a Mac of
    // being Intel on missing evidence.
    problems.push(
      facts.cpuBrand === ""
        ? `This Mac's processor could not be determined; the brevi macOS worker requires Apple silicon (M${MIN_CHIP_GENERATION} or newer).`
        : `This Mac has an Intel processor; the brevi macOS worker requires Apple silicon (M${MIN_CHIP_GENERATION} or newer).`,
    );
  } else if (chipGeneration < MIN_CHIP_GENERATION) {
    problems.push(
      `This Mac has an Apple M${chipGeneration} chip; nested virtualization requires M${MIN_CHIP_GENERATION} or newer.`,
    );
  }

  const macosMajor = parseMacosMajor(facts.productVersion);
  if (macosMajor === undefined) {
    problems.push(
      `This Mac's macOS version could not be determined; the brevi macOS worker requires macOS ${MIN_MACOS_MAJOR} or newer.`,
    );
  } else if (macosMajor < MIN_MACOS_MAJOR) {
    problems.push(
      `This Mac runs macOS ${facts.productVersion}; the brevi macOS worker requires macOS ${MIN_MACOS_MAJOR} or newer.`,
    );
  }

  return {
    supported: problems.length === 0,
    problems,
    chipGeneration,
    macosMajor,
  };
}

/** Reads one command's stdout, trimmed; any failure (missing binary, non-zero exit) resolves to "". */
function readCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 3_000 }, (err, stdout) => {
      resolve(err ? "" : stdout.trim());
    });
  });
}

/** Read the facts off this machine (sysctl, sw_vers); every field is empty when its probe fails. */
export async function detectMacHostFacts(): Promise<MacHostFacts> {
  const [cpuBrand, productVersion] = await Promise.all([
    readCommand("sysctl", ["-n", "machdep.cpu.brand_string"]),
    readCommand("sw_vers", ["-productVersion"]),
  ]);
  return { platform: process.platform, cpuBrand, productVersion };
}
