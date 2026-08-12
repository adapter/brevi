/**
 * Builds brevi as a single-file standalone executable (`bun build --compile`)
 * for the current host's platform/architecture, for the Linux worker
 * installer (packages/worker/scripts/install.sh) to fetch and run without
 * a node/bun/npm install of its own.
 *
 * `@lydell/node-pty` loads its native addon through a runtime
 * `require("@lydell/node-pty-" + process.platform + "-" + process.arch +
 * "/pty.node")`. A bundler cannot see that dynamically built specifier, so
 * without help the standalone binary dies at startup with "could not find
 * the binary package". The plugin below rewrites that one module to a
 * static require of the current platform's `pty.node`, which lets Bun embed
 * the addon in the executable. That is also why this binary has to be built
 * natively per architecture rather than cross-compiled: the plugin bakes in
 * whichever native package is installed for *this* process's platform/arch.
 *
 * The binary bundles the workspace packages (@brevi/orchestrator,
 * @brevi/worker, @brevi/sandbox, @brevi/shared, and apps/app's dashboard)
 * from their built dist/ output, so `bun run build` must have run first.
 *
 * Usage (from packages/cli): bun run scripts/build-binary.ts [--outfile <path>]
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const packageRoot = join(import.meta.dir, "..");

function parseOutfile(argv: string[]): string | undefined {
  const index = argv.indexOf("--outfile");
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value) {
    console.error("✖ --outfile needs a path argument.");
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const outfile = parseOutfile(process.argv.slice(2)) ?? join(packageRoot, "dist", "brevi");

  const entry = join(packageRoot, "src", "index.ts");
  if (!existsSync(entry)) {
    console.error(`✖ Entry point not found at ${entry}.`);
    process.exit(1);
  }

  const pkgRaw = readFileSync(join(packageRoot, "package.json"), "utf8");
  const pkg = JSON.parse(pkgRaw) as { version?: string };
  const version = pkg.version;
  if (!version) {
    console.error(`✖ Could not read a version out of ${join(packageRoot, "package.json")}.`);
    process.exit(1);
  }

  const nativePkg = `@lydell/node-pty-${process.platform}-${process.arch}`;
  console.log(`Building ${outfile} (brevi ${version}, ${process.platform}/${process.arch})...`);

  const result = await Bun.build({
    entrypoints: [entry],
    target: "bun",
    define: { "process.env.BREVI_EMBEDDED_CLI_VERSION": JSON.stringify(version) },
    plugins: [
      {
        name: "node-pty-static-binary",
        setup(build) {
          build.onLoad({ filter: /node-pty[\\/]requireBinary\.js$/ }, () => ({
            contents: `const binary = require(${JSON.stringify(`${nativePkg}/pty.node`)});\nexports.requireBinary = () => binary;\n`,
            loader: "js",
          }));
        },
      },
    ],
    compile: { outfile },
  });

  if (!result.success) {
    console.error(`✖ Build failed.`);
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }

  const sizeMib = statSync(outfile).size / (1024 * 1024);
  console.log(`✔ Built ${outfile} (${sizeMib.toFixed(1)} MiB)`);
}

await main();
