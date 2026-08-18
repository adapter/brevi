import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const packageRoot = join(import.meta.dir, "..");

function parseOutfile(argv: string[]): string | undefined {
  const index = argv.indexOf("--outfile");
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value) throw new Error("--outfile needs a path argument");
  return value;
}

async function main(): Promise<void> {
  const outfile = parseOutfile(process.argv.slice(2)) ?? join(packageRoot, "dist", "brevi-worker");
  const entry = join(packageRoot, "src", "bin.ts");
  if (!existsSync(entry)) throw new Error(`entry point not found at ${entry}`);
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version?: string };
  if (!manifest.version) throw new Error("worker package has no version");

  const nativePackage = `@lydell/node-pty-${process.platform}-${process.arch}`;
  const result = await Bun.build({
    entrypoints: [entry],
    target: "bun",
    define: { "process.env.BREVI_EMBEDDED_WORKER_VERSION": JSON.stringify(manifest.version) },
    plugins: [
      {
        name: "node-pty-static-binary",
        setup(build) {
          build.onLoad({ filter: /node-pty[\\/]requireBinary\.js$/ }, () => ({
            contents: `const binary = require(${JSON.stringify(`${nativePackage}/pty.node`)});\nexports.requireBinary = () => binary;\n`,
            loader: "js",
          }));
        },
      },
    ],
    compile: { outfile },
  });
  if (!result.success) throw new Error(result.logs.map(String).join("\n"));
  console.log(`Built ${outfile} (${(statSync(outfile).size / 1024 / 1024).toFixed(1)} MiB)`);
}

await main();
