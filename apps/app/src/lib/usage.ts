/** Formatting shared by the Usage page and the sidebar's daily-spend figure. */

/** "YYYY-MM-DD" in local time, matching how ccusage keys its days. */
export function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export const usd = (value: number) =>
  value >= 100 ? `$${Math.round(value)}` : `$${value.toFixed(2)}`;
