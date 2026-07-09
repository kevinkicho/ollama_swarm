/** Blackboard planning pipeline step — surfaced in status + UI during seeding/planning. */

export type PlanningSubphase =
  | "seeding"
  | "goal-pre-pass"
  | "research"
  | "contract"
  | "todos";

const LABELS: Record<PlanningSubphase, string> = {
  seeding: "Building repo seed (file list, README, endpoint catalog)",
  "goal-pre-pass": "Goal analysis (optional codebase enrichment)",
  research: "Web research pre-pass",
  contract: "Deriving exit contract",
  todos: "Posting initial todos",
};

export function planningSubphaseLabel(subphase: PlanningSubphase | undefined): string {
  if (!subphase) return "Planning";
  return LABELS[subphase] ?? subphase;
}