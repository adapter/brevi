/**
 * Prints the version of @brevi/cli, and nothing else, to stdout.
 *
 * The desktop app has no meaningful version of its own: every packaged
 * build ships a staged copy of @brevi/cli (see stage-cli.ts) alongside the
 * embedded orchestrator it supervises, and an update is only worth shipping
 * when that pair changes. Rather than hand-bump apps/desktop/package.json
 * in step, the packaging scripts read the CLI's version at package time
 * (`-c.extraMetadata.version=$(bun scripts/cli-version.ts)`) and inject it
 * as the artifact version, so the app and the orchestrator it embeds can
 * never disagree.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PACKAGE_JSON = resolve(HERE, "..", "..", "..", "packages", "cli", "package.json");

const manifest = JSON.parse(readFileSync(CLI_PACKAGE_JSON, "utf8")) as { version?: string };
if (!manifest.version) {
  console.error(`✖ ${CLI_PACKAGE_JSON} has no "version" field.`);
  process.exit(1);
}

console.log(manifest.version);
