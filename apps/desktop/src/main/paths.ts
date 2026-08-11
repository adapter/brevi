import { join } from "node:path";
import { ORCHESTRATOR_LOG_PATH as SHARED_ORCHESTRATOR_LOG_PATH } from "@brevi/shared";

export interface CliEntryContext {
  /** app.isPackaged */
  packaged: boolean;
  /** process.resourcesPath in a packaged app. */
  resourcesPath: string;
  /** Directory of the running main bundle (apps/desktop/dist in a repo checkout). */
  here: string;
}

/**
 * Absolute path of the @brevi/cli entry the app supervises. Packaged builds
 * carry it in resources/cli, staged by scripts/stage-cli.ts as a complete
 * production install (manifest at the root, bundle under dist/, dependencies
 * under node_modules/), so the path there mirrors the npm package's own
 * layout. A repo checkout uses the workspace build. BREVI_DESKTOP_CLI_ENTRY
 * overrides both, for development.
 */
export function resolveCliEntry(context: CliEntryContext): string {
  // A development escape hatch, not persistent configuration (which never
  // reads environment variables in this codebase), so it's fine to read here.
  const override = process.env.BREVI_DESKTOP_CLI_ENTRY;
  if (override) return override;

  if (context.packaged) {
    return join(context.resourcesPath, "cli", "dist", "index.js");
  }

  // The bundle lives at apps/desktop/dist/main.js, so the repo root is three
  // levels up from `here` (apps/desktop/dist).
  return join(context.here, "..", "..", "..", "packages", "cli", "dist", "index.js");
}

/** ~/.brevi/logs/orchestrator.log, the log the supervised process tees to. */
export const ORCHESTRATOR_LOG_PATH: string = SHARED_ORCHESTRATOR_LOG_PATH;
