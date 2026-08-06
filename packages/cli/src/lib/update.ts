import { fileURLToPath } from "node:url";
import pc from "picocolors";

export const PACKAGE_NAME = "@brevi/cli";
export const CHANGELOG_URL = "https://brevi.dev/reference/changelog/";

const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const REGISTRY_TIMEOUT_MS = 5000;
/** Shorter budget for the fire-and-forget notice in `ui` / `start` / `status`. */
const NOTICE_TIMEOUT_MS = 1500;

/** Fetches the latest published version of @brevi/cli from the npm registry. */
export async function fetchLatestVersion(timeoutMs = REGISTRY_TIMEOUT_MS): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(REGISTRY_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`npm registry answered HTTP ${res.status}`);
    const body = (await res.json()) as { version?: unknown };
    if (typeof body.version !== "string" || body.version.length === 0) {
      throw new Error("npm registry response had no version field");
    }
    return body.version;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Semver comparison: negative when a < b, 0 when equal, positive when a > b.
 * Handles numeric x.y.z cores and prerelease identifiers (a release outranks
 * its prereleases); build metadata is ignored.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    const ca = pa.core[i] ?? 0;
    const cb = pb.core[i] ?? 0;
    if (ca !== cb) return ca - cb;
  }
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;
  const len = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i++) {
    const ia = pa.prerelease[i];
    const ib = pb.prerelease[i];
    if (ia === undefined) return -1;
    if (ib === undefined) return 1;
    if (ia === ib) continue;
    const na = /^\d+$/.test(ia) ? Number(ia) : null;
    const nb = /^\d+$/.test(ib) ? Number(ib) : null;
    if (na !== null && nb !== null) return na - nb;
    if (na !== null) return -1; // numeric identifiers sort below alphanumeric
    if (nb !== null) return 1;
    return ia < ib ? -1 : 1;
  }
  return 0;
}

function parseVersion(version: string): { core: number[]; prerelease: string[] } {
  const rest = version.split("+", 1)[0] ?? version;
  const dash = rest.indexOf("-");
  const core = (dash === -1 ? rest : rest.slice(0, dash))
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  while (core.length < 3) core.push(0);
  const prerelease = dash === -1 ? [] : rest.slice(dash + 1).split(".");
  return { core, prerelease };
}

export type InstallMethod =
  /** A persistent global install we can update in place. */
  | { kind: "global"; manager: "npm" | "bun" | "pnpm" | "yarn"; installArgs: string[] }
  /** A per-invocation runner cache; nothing persistent to update. */
  | { kind: "runner"; runner: "npx" | "bunx" | "pnpm dlx" }
  /** Not under node_modules at all, e.g. a checkout of the repo. */
  | { kind: "unknown" };

/**
 * Works out how the running CLI was installed by classifying the real path of
 * this module (Node resolves the bin symlink, so a global install lands under
 * the package manager's global node_modules).
 */
export function detectInstallMethod(entryPath = fileURLToPath(import.meta.url)): InstallMethod {
  const p = entryPath.split("\\").join("/");
  const global = (manager: "npm" | "bun" | "pnpm" | "yarn", args: string[]): InstallMethod => ({
    kind: "global",
    manager,
    installArgs: args,
  });

  if (p.includes("/_npx/")) return { kind: "runner", runner: "npx" };
  if (p.includes("/.bun/install/cache/") || p.includes("/bunx-")) {
    return { kind: "runner", runner: "bunx" };
  }
  if (p.includes("/dlx-")) return { kind: "runner", runner: "pnpm dlx" };
  if (p.includes("/.bun/install/global/")) return global("bun", ["add", "-g"]);
  if (p.includes("/pnpm/global/") || p.includes("/pnpm-global/")) return global("pnpm", ["add", "-g"]);
  if (p.includes("/.config/yarn/global/") || p.includes("/yarn/global/")) {
    return global("yarn", ["global", "add"]);
  }
  if (p.includes("/node_modules/")) return global("npm", ["install", "-g"]);
  return { kind: "unknown" };
}

/**
 * Returns a printable "new version available" notice, or null when up to date
 * (or when npm can't be reached in time, since the notice must never block or
 * fail the command it rides on).
 */
export async function updateNotice(currentVersion: string): Promise<string | null> {
  try {
    const latest = await fetchLatestVersion(NOTICE_TIMEOUT_MS);
    if (compareVersions(currentVersion, latest) >= 0) return null;
    return [
      pc.yellow(`! A new version of ${PACKAGE_NAME} is available: ${currentVersion} → ${latest}`),
      pc.dim(`  Run \`brevi update\` (changelog: ${CHANGELOG_URL})`),
    ].join("\n");
  } catch {
    return null;
  }
}
