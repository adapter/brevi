/** Human-readable formatting for millisecond durations. */

/**
 * Formats a millisecond duration for humans: seconds under a minute (`"2s"`),
 * minutes under an hour (`"45m"`), whole hours (`"4h"`), or hours with
 * leftover minutes (`"1h30m"`). Negative or zero durations format as `"0s"`.
 *
 * @example
 * formatDuration(2000) // "2s"
 * formatDuration(45 * 60_000) // "45m"
 * formatDuration(240 * 60_000) // "4h"
 * formatDuration(90 * 60_000) // "1h30m"
 */
export function formatDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`;
}
