/** Pre-stream phases: prompt submitted, awaiting first provider byte (not in-app queue). */
export function isPreStreamActivityPhase(
  phase: string | undefined,
): phase is "queued" | "waiting" | "retrying" {
  return phase === "queued" || phase === "waiting" || phase === "retrying";
}