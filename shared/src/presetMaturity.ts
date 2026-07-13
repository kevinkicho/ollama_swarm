/**
 * Server-side maturity labels for presets (mirrors web setup badges).
 * Used to fail-closed experimental/research starts unless allowExperimental.
 */

export type PresetMaturity = "core" | "supported" | "experimental" | "research";

/** Keep in sync with web/src/components/setup/presets.ts maturity fields. */
export const PRESET_MATURITY: Record<string, PresetMaturity> = {
  "round-robin": "supported",
  blackboard: "core",
  "role-diff": "experimental",
  council: "core",
  "orchestrator-worker": "supported",
  "orchestrator-worker-deep": "research",
  "debate-judge": "experimental",
  "map-reduce": "research",
  stigmergy: "experimental",
  baseline: "experimental",
  moa: "experimental",
  pipeline: "experimental",
};

export function requiresExperimentalAck(preset: string): boolean {
  const m = PRESET_MATURITY[preset];
  return m === "experimental" || m === "research";
}
