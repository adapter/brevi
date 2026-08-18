/** Formatting shared by the Usage page and the sidebar's daily-spend figure. */

/** "YYYY-MM-DD" in local time, matching how ccusage keys its days. */
export function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const usdFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

/** "$1,234.56": thousands separated, cents always shown. */
export const usd = (value: number) => usdFormat.format(value);
