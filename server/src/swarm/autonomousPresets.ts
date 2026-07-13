// Which presets treat rounds===0 (or continuous) as open-ended autonomous
// mode. Other presets historically treated rounds=0 as an empty for-loop
// (zero work) or clamped it to 1 (MoA) — which surprised operators who
// used the UI "0 = continuous" affordance.

import type { PresetId } from "./SwarmRunner.js";

/** Presets that implement true open-ended / ambition-ratchet autonomous runs. */
export const AUTONOMOUS_ROUNDS_PRESETS: ReadonlySet<PresetId> = new Set([
  "blackboard",
  "council",
]);

/**
 * Soft default wall-clock when autonomous/continuous starts with no resource
 * cap. Fail-closed: unbounded runs without a stop signal burn tokens forever.
 * Operators can raise via setup (wallClockCapMin) or mid-run RECONFIG.
 */
export const DEFAULT_AUTONOMOUS_WALL_CLOCK_MS = 8 * 60 * 60 * 1000; // 8 hours

export function supportsAutonomousRounds(preset: PresetId): boolean {
  return AUTONOMOUS_ROUNDS_PRESETS.has(preset);
}

/**
 * If this is an open-ended run with no token/wall/cost cap, apply a default
 * wall-clock. Returns the cap to inject (or null if already bounded).
 */
export function ensureAutonomousResourceCap(input: {
  preset: PresetId;
  rounds: number;
  tokenBudget?: number;
  wallClockCapMs?: number;
  maxCostUsd?: number;
}): { wallClockCapMs: number; appliedDefault: true } | { wallClockCapMs?: number; appliedDefault: false } {
  const openEnded =
    supportsAutonomousRounds(input.preset)
    && (input.rounds === 0 || input.rounds >= 1_000_000);
  if (!openEnded) {
    return { wallClockCapMs: input.wallClockCapMs, appliedDefault: false };
  }
  const hasToken = (input.tokenBudget ?? 0) > 0;
  const hasWall = (input.wallClockCapMs ?? 0) > 0;
  const hasCost = (input.maxCostUsd ?? 0) > 0;
  if (hasToken || hasWall || hasCost) {
    return { wallClockCapMs: input.wallClockCapMs, appliedDefault: false };
  }
  return {
    wallClockCapMs: DEFAULT_AUTONOMOUS_WALL_CLOCK_MS,
    appliedDefault: true,
  };
}

/**
 * Resolve effective rounds for a start request.
 * - rounds > 0: use as-is
 * - rounds === 0 on autonomous-capable presets: keep 0
 * - rounds === 0 on other presets: reject (caller returns 400) unless continuous
 *   rewrote the request (continuous is only safe with a budget cap — route layer)
 * - rounds omitted: blackboard default 0, others default 3
 */
export function resolveEffectiveRounds(input: {
  preset: PresetId;
  rounds?: number;
  continuous?: boolean;
}): { ok: true; rounds: number } | { ok: false; error: string } {
  const { preset, rounds: explicitRounds, continuous } = input;

  if (explicitRounds != null && explicitRounds > 0) {
    return { ok: true, rounds: explicitRounds };
  }

  if (explicitRounds === 0) {
    if (supportsAutonomousRounds(preset)) {
      return { ok: true, rounds: 0 };
    }
    return {
      ok: false,
      error:
        `rounds=0 (autonomous / continuous) is only supported for blackboard and council. ` +
        `Preset "${preset}" would run zero cycles or silently clamp — set rounds ≥ 1 ` +
        `(or switch preset to council/blackboard for open-ended ambition).`,
    };
  }

  // omitted
  if (continuous) {
    if (supportsAutonomousRounds(preset)) {
      // continuous flag → effectively unbounded; runners see large N
      return { ok: true, rounds: 1_000_000 };
    }
    return {
      ok: false,
      error:
        `continuous mode is only supported for blackboard and council (got preset="${preset}").`,
    };
  }

  return { ok: true, rounds: preset === "blackboard" ? 0 : 3 };
}
