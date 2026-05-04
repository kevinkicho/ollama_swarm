// T-Item-AutoRoute (2026-05-04): pure helper for per-prompt model
// routing based on role category. Used by runners that opt in via
// cfg.dynamicModelRoute. The helper picks among the per-tier
// overrides (plannerModel / workerModel / auditorModel) with cfg.model
// as the fallback.
//
// Role categorization mirrors costBreakdown.CODING_TIER_ROLES + the
// auditor/judge handling: judgement roles → planner/auditor model;
// structural roles → worker model.

export type RoleCategory = "planner" | "worker" | "auditor" | "judge";

/** Map a role label (as emitted by topology.defaultRoleForIndex)
 *  to a category. Defaults to "worker" for unknown labels. Pure. */
export function categorizeRole(role: string): RoleCategory {
  switch (role) {
    case "planner":
    case "orchestrator":
    case "reducer":
      return "planner";
    case "auditor":
      return "auditor";
    case "judge":
      return "judge";
    case "mid-lead":
    case "worker":
    case "mapper":
    case "drafter":
    case "explorer":
    case "peer":
    case "pro":
    case "con":
    case "role-diff":
      return "worker";
    default:
      return "worker";
  }
}

/** Per-prompt model selection for the dynamic-model-route lever.
 *  Returns the model id for the given role, falling back through:
 *    auditor → cfg.auditorModel → cfg.plannerModel → cfg.model
 *    judge   → cfg.auditorModel → cfg.plannerModel → cfg.model
 *    planner → cfg.plannerModel → cfg.model
 *    worker  → cfg.workerModel → cfg.model
 *  Pure — exported for tests. */
export function selectModelForRole(
  role: string,
  cfg: {
    model: string;
    workerModel?: string;
    plannerModel?: string;
    auditorModel?: string;
  },
): string {
  const cat = categorizeRole(role);
  switch (cat) {
    case "planner":
      return cfg.plannerModel ?? cfg.model;
    case "auditor":
    case "judge":
      return cfg.auditorModel ?? cfg.plannerModel ?? cfg.model;
    case "worker":
      return cfg.workerModel ?? cfg.model;
  }
}
