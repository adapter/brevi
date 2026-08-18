#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { WORKER_MAX_CONCURRENCY } from "@brevi/shared";

const VERSION = process.env.BREVI_EMBEDDED_WORKER_VERSION ?? "0.0.0";

interface Options {
  host?: string;
  token?: string;
  tokenFile?: string;
  name?: string;
  concurrency?: number;
}

function usage(): never {
  console.log(`brevi-worker ${VERSION}\n\nUsage: brevi-worker --host <url> [--name <name>] [--concurrency <n>]`);
  process.exit(0);
}

function parse(argv: string[]): Options {
  const options: Options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") usage();
    if (flag === "--version" || flag === "-v") {
      console.log(VERSION);
      process.exit(0);
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`${flag} requires a value`);
    index += 1;
    if (flag === "--host") options.host = value;
    else if (flag === "--token") options.token = value;
    else if (flag === "--token-file") options.tokenFile = value;
    else if (flag === "--name") options.name = value;
    else if (flag === "--concurrency") {
      const concurrency = Number(value);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > WORKER_MAX_CONCURRENCY) {
        throw new Error(`--concurrency must be between 1 and ${WORKER_MAX_CONCURRENCY}`);
      }
      options.concurrency = concurrency;
    } else throw new Error(`unknown option: ${flag}`);
  }
  return options;
}

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2));
  if (!options.host) throw new Error("--host is required");
  // Keep version/help usable without loading the Linux-only PTY runtime. The
  // published worker itself is built natively on Linux in CI.
  const { enrollmentFor, runWorker } = await import("./index.js");
  const token = options.tokenFile
    ? (await readFile(options.tokenFile, "utf8")).trim()
    : options.token ?? process.env.BREVI_TOKEN;
  if (!token && !(await enrollmentFor(options.host))) {
    throw new Error("this machine is not enrolled and no pairing token was provided");
  }
  await runWorker({
    hostUrl: options.host,
    token,
    name: options.name,
    concurrency: options.concurrency,
  });
}

main().catch((error: unknown) => {
  console.error(`[brevi-worker] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
