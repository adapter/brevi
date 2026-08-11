/** Restart delays after consecutive orchestrator crashes, capped so a hard failure retries forever without hammering. */
export const RESTART_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

export const MAX_RESTART_ATTEMPTS = 8;

/** An orchestrator that stayed up this long counts as healthy: the next crash restarts from the first delay. */
export const HEALTHY_UPTIME_MS = 60_000;

/** Delay before restart attempt `attempt` (1-based); the last entry repeats. */
export function restartDelay(attempt: number): number {
  const index = Math.min(Math.max(attempt, 1) - 1, RESTART_DELAYS_MS.length - 1);
  const lastDelay = RESTART_DELAYS_MS[RESTART_DELAYS_MS.length - 1] ?? 0;
  return RESTART_DELAYS_MS[index] ?? lastDelay;
}
