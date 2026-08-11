// Runs a sequence of ensureConfig() calls (given as a JSON array on the
// CONFIG_PROBE_OPS env var) against whatever HOME this process was spawned
// with, then prints a JSON array of results to stdout.
//
// Spawned as its own subprocess by config.test.ts, with HOME set on that
// spawn's real environment: see helpers/pid-probe.ts for why (Bun's
// os.homedir(), which @brevi/shared's CONFIG_PATH is computed from, only
// honours HOME present on the process's environment at startup, not
// process.env mutated at runtime), so this can't be done by importing
// config.ts directly into a bun:test file. Calling ensureConfig() more than
// once within one spawn exercises both the "no file yet" and "file already
// there" branches against the same temp $HOME, none of it touching the real
// ~/.brevi.
import { ensureConfig } from "../../src/main/config.js";

type Op = { op: "ensure" };

const ops = JSON.parse(process.env.CONFIG_PROBE_OPS ?? "[]") as Op[];
const results: unknown[] = [];

for (const entry of ops) {
  if (entry.op === "ensure") {
    const { config, firstLaunch } = await ensureConfig();
    results.push({ firstLaunch, provider: config.sandbox.provider });
  }
}

process.stdout.write(JSON.stringify(results));
