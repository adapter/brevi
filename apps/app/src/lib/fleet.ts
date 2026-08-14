import type { HealthResponse, WorkerView } from "@brevi/shared";

/**
 * True when this machine cannot execute runs and no worker is online, so
 * queued runs just sit there and the UI should say why. Only a definite
 * "none" counts; absent health never does.
 */
export function queueOnly(health: HealthResponse | null, workers: WorkerView[]): boolean {
  return (
    health?.hostExecution?.kind === "none" &&
    workers.every((worker) => worker.connection !== "online")
  );
}
