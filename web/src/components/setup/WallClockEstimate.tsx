// Improvement #2 from 2026-04-23 retro: wall-clock budget estimator.
// Mean per-turn seconds observed during today's vocabmaster + multi-
// agent-orchestrator runs. The 7-preset tour exposed that rounds=5
// with N≥3 agents on glm-5.1 needed ~25 min, not 15 — Kevin's
// budget was systematically 50% short.
//
// MODEL_TURN_SECONDS maps the dominant model to its observed mean
// turn time (success path). Falls back to 60s for unknown models.
// Update as new runs widen the dataset.
const MODEL_TURN_SECONDS: Record<string, number> = {
  // 2026-04-27 update: deepseek-v4-pro provisional 65s based on
  // run 0254ca7c (single data point). Reverted from default 2026-04-27
  // afternoon due to Ollama serving congestion — kept here for the
  // estimator since users can still pick it explicitly.
  "deepseek-v4-pro:cloud": 65,
  "nemotron-3-super:cloud": 30,
  "glm-5.1:cloud": 70,
  "gemma4:31b-cloud": 30,
};
const DEFAULT_TURN_SECONDS = 60;

function turnSecondsForModel(model: string): number {
  return MODEL_TURN_SECONDS[model.trim()] ?? DEFAULT_TURN_SECONDS;
}

// Per-preset wall-clock estimator. Returns seconds. Each preset's
// per-round shape determines the multiplier:
//   - SEQUENTIAL (round-robin, role-diff, council reveal, debate):
//     each round is N agents prompted in sequence → N × turn × R
//   - PARALLEL FANOUT (stigmergy): all N agents fire concurrently
//     each round → 1 × turn × R (best case; cloud may serialize)
//   - HIERARCHICAL (orchestrator-worker, map-reduce, council draft):
//     1 lead + N-1 parallel children → ~2 × turn × R (lead twice)
//   - BLACKBOARD: not rounds-based; estimator returns null and the
//     UI shows "uses wall-clock cap" instead.
// Includes a 1.2× safety margin baked in (cloud variance).
function estimateWallClockSeconds(
  presetId: string,
  agentCount: number,
  rounds: number,
  mainModel: string,
): number | null {
  const t = turnSecondsForModel(mainModel);
  const r = Math.max(1, rounds);
  const n = Math.max(1, agentCount);
  const SAFETY = 1.2;
  switch (presetId) {
    case "blackboard":
      return null;
    case "round-robin":
    case "role-diff":
    case "council":
      return Math.round(n * t * r * SAFETY);
    case "debate-judge":
      // Focused turns (PRO/CON/JUDGE) typically run ~30% faster.
      return Math.round(3 * t * r * SAFETY * 0.7);
    case "orchestrator-worker":
    case "map-reduce":
      // Lead runs twice per round (plan + synth); workers in parallel.
      return Math.round(2 * t * r * SAFETY);
    case "orchestrator-worker-deep":
      // Per cycle: top-plan + mid-plan (parallel) + workers (parallel) +
      // mid-synth (parallel) + top-synth = 5 sequential turns of leads
      // across the critical path (workers happen inside the mid-lead's
      // turn so don't add extra walls). 5*t*r is the rough bound.
      return Math.round(5 * t * r * SAFETY);
    case "stigmergy":
      return Math.round(t * r * SAFETY);
    default:
      return Math.round(n * t * r * SAFETY);
  }
}

function formatDurationSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm > 0 ? `${h}h ${mm}m` : `${h}h`;
}

// Improvement #2 from 2026-04-23 retro: wall-clock budget hint that
// renders right above the Start button. Pulls observed per-model
// turn-second data + per-preset shape from the helpers up top.
//
// For blackboard the estimator returns null (not rounds-based); we
// show "uses wall-clock cap" + the cap value if the user set one.
//
// For everything else: render the estimate, plus a comparison vs the
// wall-clock cap when the user set one. Color-codes: green when
// estimate fits comfortably (< 80% of cap or no cap), amber when
// close (80-120%), rose when likely to truncate (> 120%).
export function WallClockEstimate({
  presetId,
  agentCount,
  rounds,
  mainModel,
  wallClockCapMin,
}: {
  presetId: string;
  agentCount: number;
  rounds: number;
  mainModel: string;
  wallClockCapMin: string;
}) {
  if (presetId === "blackboard") {
    const cap = wallClockCapMin.trim();
    const capParsed = Number(cap);
    const capValid = cap.length > 0 && Number.isFinite(capParsed) && capParsed >= 1;
    return (
      <div className="text-xs text-ink-400 px-1">
        Blackboard runs are gated by wall-clock cap, not rounds.{" "}
        {capValid
          ? `This run will stop after ~${capParsed} min.`
          : "Defaulting to the 8 h baked-in cap (override in Advanced settings)."}
      </div>
    );
  }
  const seconds = estimateWallClockSeconds(presetId, agentCount, rounds, mainModel);
  if (seconds === null) return null;
  const cap = wallClockCapMin.trim();
  const capMinParsed = Number(cap);
  const capValid = cap.length > 0 && Number.isFinite(capMinParsed) && capMinParsed >= 1;
  const capSec = capValid ? Math.round(capMinParsed * 60) : null;

  let color = "text-ink-400";
  let suffix = "";
  if (capSec !== null) {
    const ratio = seconds / capSec;
    if (ratio > 1.2) {
      color = "text-rose-300";
      suffix = ` — likely to hit the ${formatDurationSeconds(capSec)} cap before finishing rounds=${rounds}`;
    } else if (ratio > 0.8) {
      color = "text-amber-300";
      suffix = ` — close to the ${formatDurationSeconds(capSec)} cap, may truncate`;
    } else {
      color = "text-emerald-300";
      suffix = ` — fits inside the ${formatDurationSeconds(capSec)} cap`;
    }
  }
  return (
    <div className={`text-xs ${color} px-1`}>
      Estimated wall-clock: ~{formatDurationSeconds(seconds)}
      {suffix}.
      <div className="text-ink-500 mt-0.5">
        Based on {turnSecondsForModel(mainModel)}s/turn for {mainModel || "(unknown model)"} × {presetId} shape ×
        rounds={rounds}, agents={agentCount}, with 1.2× safety margin.
      </div>
    </div>
  );
}
