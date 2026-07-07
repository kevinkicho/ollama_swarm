import { useEffect, useState } from "react";

/** Terse wall-clock duration for UI tickers (e.g. "34s", "3m05s"). */
export function formatElapsed(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  if (mins < 60) return `${mins}m${rem.toString().padStart(2, "0")}s`;
  const hours = Math.floor(mins / 60);
  const mrem = mins % 60;
  return `${hours}h${mrem.toString().padStart(2, "0")}m`;
}

/** Tick every second while `active` to show elapsed time since `sinceMs`. */
export function useElapsedSince(sinceMs: number | undefined, active: boolean): string | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active || sinceMs === undefined) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [active, sinceMs]);
  if (!active || sinceMs === undefined) return null;
  return formatElapsed(Date.now() - sinceMs);
}