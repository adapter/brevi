import { useEffect, useState } from "react";

/** A clock that only ticks while something on screen depends on it. */
export function useNow(running: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [running, intervalMs]);

  return now;
}
