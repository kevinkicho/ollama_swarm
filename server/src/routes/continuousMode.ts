// Task #132: pure validator for the continuous-mode safety guard.
// Extracted from routes/swarm.ts so the rule (which presets need an
// explicit cap and which are already cap-driven) can be unit-tested
// without the config import-time env validation that swarm.ts pulls
// in transitively. Returns the error message string when the request
// is unsafe; null when it's safe (or continuous mode isn't requested).

export interface ContinuousModeArgs {
  continuous?: boolean;
  preset: string;
  tokenBudget?: number;
  wallClockCapMs?: number;
}

export function validateContinuousMode(args: ContinuousModeArgs): string | null {
  if (args.continuous !== true) return null;
  // Blackboard has its own baked-in commits/todos caps + a default 8h
  // wall-clock cap, so a continuous-mode blackboard run is bounded
  // even without a per-run override. Discussion presets (everything
  // else) have only the per-round tokenBudget check from #124, so
  // they need an explicit cap.
  if (args.preset === "blackboard") return null;
  const hasTokenCap = (args.tokenBudget ?? 0) > 0;
  const hasWallClockCap = (args.wallClockCapMs ?? 0) > 0;
  if (hasTokenCap || hasWallClockCap) return null;
  return `Continuous mode requires at least one budget cap. Set tokenBudget (e.g. 5_000_000) or wallClockCapMs (e.g. 1_800_000 for 30 min) — without one, the swarm has no stop signal.`;
}
