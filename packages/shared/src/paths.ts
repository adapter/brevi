import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Host paths brevi keeps its state under. Node-only on purpose: the dashboard
 * imports the config schema to validate its forms, and a browser has no home
 * directory to resolve these against. Nothing in `config.ts` may import this
 * module.
 */

/** Root directory for all brevi state: config, run history, artifacts, workspaces. */
export const BREVI_HOME = join(homedir(), ".brevi");
export const CONFIG_PATH = join(BREVI_HOME, "config.json");
export const RUNS_DIR = join(BREVI_HOME, "runs");
export const WORKSPACES_DIR = join(BREVI_HOME, "workspaces");
/** Per-repository memories, one JSON file per repo key (see MemoryStore). */
export const MEMORIES_DIR = join(BREVI_HOME, "memories");
/**
 * Enrolled workers on the host: runtime state, not configuration, so it lives
 * beside the run history rather than in config.json (see FleetStore).
 */
export const FLEET_PATH = join(BREVI_HOME, "fleet.json");
/**
 * A worker's own enrollment on its own machine: the id the host assigned it
 * and the credential it earned by redeeming a pairing token. The only fleet
 * secret that touches worker disk, and what makes a reconnect recognisable as
 * the same worker.
 */
export const WORKER_STATE_PATH = join(BREVI_HOME, "worker.json");
/** Directory for log files, e.g. the orchestrator's tee target. */
export const LOGS_DIR = join(BREVI_HOME, "logs");
/** Persistent orchestrator log used as diagnosis evidence. */
export const ORCHESTRATOR_LOG_PATH = join(LOGS_DIR, "orchestrator.log");
/** Fleet state the host keeps across restarts (see the orchestrator's LeaseStore). */
export const FLEET_DIR = join(BREVI_HOME, "fleet");
/** Outstanding run leases, reloaded on boot so a host restart does not lose in-flight runs. */
export const LEASES_PATH = join(FLEET_DIR, "leases.json");
