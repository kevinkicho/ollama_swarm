// R16 (2026-05-04): per-run health score (0–100).
//
// One number that compresses "did this run go well?" into a value the
// dashboard can sort + threshold on. Inputs:
//   - commits landed + tier achieved   (positive — actual artifacts)
//   - retry count                       (negative — wasted budget)
//   - empty-turn rate                   (negative — model didn't engage)
//   - cap proximity                     (negative — ran out of room)
//   - error count                       (negative — failures matter)
//
// Score is intentionally rough — buckets matter (90+ = green, 60–89 =
// yellow, <60 = red), individual single-point swings don't.
//
// Pure: no I/O.

export interface RunHealthInput {
  /** Commits landed (or hunks applied). 0 = nothing shipped. */
  commitsLanded: number;
  /** Verifier tier (0 = nothing useful, 3 = perfect). */
  tier: number;
  /** Total turns across all agents. */
  totalTurns: number;
  /** Turns that produced empty / unparseable output. */
  emptyTurns: number;
  /** Number of times we retried a prompt (per promptWithRetry). */
  retryCount: number;
  /** Total wall-clock used (ms). */
  durationMs: number;
  /** Wall-clock cap (ms). 0 means uncapped. */
  wallClockCapMs: number;
  /** Commits cap (or 0 for uncapped). */
  commitsCap: number;
  /** Total errors classified during the run. */
  errorCount: number;
}

export interface RunHealthScore {
  /** 0–100, higher is healthier. */
  score: number;
  /** Bucket label for dashboards. */
  bucket: "green" | "yellow" | "red";
  /** Per-component breakdown for diagnostics. */
  components: {
    artifactPoints: number;
    tierPoints: number;
    retryPenalty: number;
    emptyTurnPenalty: number;
    capProximityPenalty: number;
    errorPenalty: number;
  };
  /** Plain-English reason (top 1–2 contributors to the bucket). */
  reason: string;
}

export function computeRunHealthScore(input: RunHealthInput): RunHealthScore {
  // Start from neutral 60 and adjust both directions.
  let score = 60;
  // 1. Artifact bonus: 0–25 points based on commits.
  const artifactPoints = clamp(input.commitsLanded * 6, 0, 25);
  score += artifactPoints;
  // 2. Tier bonus: 0–15 points (5 per tier, capped at tier 3).
  const tierPoints = clamp(input.tier * 5, 0, 15);
  score += tierPoints;
  // 3. Retry penalty: -1 per retry, max -20.
  const retryPenalty = -clamp(input.retryCount, 0, 20);
  score += retryPenalty;
  // 4. Empty-turn rate penalty: -25 if half the turns are empty.
  const emptyRate = input.totalTurns > 0 ? input.emptyTurns / input.totalTurns : 0;
  const emptyTurnPenalty = -clamp(Math.round(emptyRate * 50), 0, 25);
  score += emptyTurnPenalty;
  // 5. Cap proximity penalty: when we used >90% of either cap, -10.
  let capProximityPenalty = 0;
  if (input.wallClockCapMs > 0 && input.durationMs / input.wallClockCapMs > 0.9) {
    capProximityPenalty -= 10;
  }
  if (
    input.commitsCap > 0 &&
    input.commitsLanded / input.commitsCap > 0.9
  ) {
    capProximityPenalty -= 5;
  }
  score += capProximityPenalty;
  // 6. Error penalty: -2 per classified error, max -20.
  const errorPenalty = -clamp(input.errorCount * 2, 0, 20);
  score += errorPenalty;
  score = clamp(Math.round(score), 0, 100);
  const bucket: RunHealthScore["bucket"] =
    score >= 90 ? "green" : score >= 60 ? "yellow" : "red";
  const reason = explain({
    score,
    bucket,
    artifactPoints,
    tierPoints,
    retryPenalty,
    emptyTurnPenalty,
    capProximityPenalty,
    errorPenalty,
    input,
  });
  return {
    score,
    bucket,
    components: {
      artifactPoints,
      tierPoints,
      retryPenalty,
      emptyTurnPenalty,
      capProximityPenalty,
      errorPenalty,
    },
    reason,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function explain(input: {
  score: number;
  bucket: RunHealthScore["bucket"];
  artifactPoints: number;
  tierPoints: number;
  retryPenalty: number;
  emptyTurnPenalty: number;
  capProximityPenalty: number;
  errorPenalty: number;
  input: RunHealthInput;
}): string {
  const negatives: Array<[number, string]> = [];
  if (input.errorPenalty < 0)
    negatives.push([input.errorPenalty, `${input.input.errorCount} classified errors`]);
  if (input.emptyTurnPenalty < 0)
    negatives.push([input.emptyTurnPenalty, `${input.input.emptyTurns}/${input.input.totalTurns} empty turns`]);
  if (input.retryPenalty < 0)
    negatives.push([input.retryPenalty, `${input.input.retryCount} prompt retries`]);
  if (input.capProximityPenalty < 0)
    negatives.push([input.capProximityPenalty, "near a hard cap"]);
  negatives.sort((a, b) => a[0] - b[0]); // most negative first
  if (input.bucket === "green") {
    return `Score ${input.score} — green. Landed ${input.input.commitsLanded} commits at tier ${input.input.tier}.`;
  }
  if (negatives.length === 0) {
    return `Score ${input.score} — ${input.bucket}. No major penalty contributors; low artifact count holds the score down.`;
  }
  const top = negatives.slice(0, 2).map((n) => n[1]).join(" + ");
  return `Score ${input.score} — ${input.bucket}. Top contributors: ${top}.`;
}
