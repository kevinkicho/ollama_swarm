// Partial RunConfig fields — RunConfigCore
import type { SwarmRole } from "../roles.js";
import type { PresetId } from "../SwarmRunner.js";

export interface RunConfigCore {
  repoUrl: string;
  localPath: string;
  agentCount: number;
  rounds: number;
  model: string;
  preset: PresetId;
  // optional user-authored directive that steers the blackboard planner
  // planner's first-pass contract. Threaded into PlannerSeed.userDirective
  // and incorporated into the first-pass contract prompt so criteria are
  // shaped by user intent from turn 1. Silently ignored by non-blackboard
  // presets (no auto-contract to shape).
  userDirective?: string;
  // per-preset knobs, surfaced by the Start-a-swarm form's Advanced section.
  // Advanced section. Each is ignored by presets that don't consume it:
  // only role-diff uses `roles`, only blackboard uses `councilContract`,
  // only debate-judge uses `proposition`.
  /** Custom role list for role-diff. Falls back to DEFAULT_ROLES when absent or empty. */
  roles?: SwarmRole[];
  /**
   * Proposition text for debate-judge, captured at start time. Previously
   * users had to call `injectUser(text)` BEFORE `start()` to set the
   * proposition — awkward because the SetupForm submits start immediately.
   * `proposition`, when present, takes precedence over the inject path.
   */
  proposition?: string;
  /**
   * Task #124: optional per-run hard cap on total tokens consumed
   * (prompt + response). When set, the runner polls the proxy-backed
   * tokenTracker every cap-check tick; once cumulative-since-start
   * exceeds this number, the runner halts the same way wall-clock
   * does. User-supplied — no default, no implicit cap. Useful for
   * autonomous mode where wall-clock alone doesn't bound cost (a
   * stuck retry loop can burn tokens with little wall-clock movement).
   * Empty / undefined = no token cap (legacy behavior).
   */

  /** Marker: this run was started by the Brain-as-OS for self-improvement. */
  brainInitiated?: boolean;
  /** If brain-initiated, the proposal id that triggered it (for traceability across concurrent runs). */
  brainProposalId?: string;
  /** Local Ollama mode: strips :cloud from all model refs. */
  useLocal?: boolean;
  /** Multi-user: identifies who started this run. Default "default". */
  createdBy?: string;
  /** Correlation ID from the HTTP request that started this run. */
  reqId?: string;
  /**
   * Pipeline preset: chains multiple sub-runs together. Each phase's
   * transcript + deliverable feeds the next phase's seed directive.
   * When set AND preset is "pipeline", the PipelineRunner executes
   * the phases sequentially. Absent → DEFAULT_PIPELINE used.
   */
  pipeline?: import("../pipelinePhases.js").PipelineConfig;
  /**
   * Internal: set by PipelineRunner for phases after the first (i>0).
   * When true, sub-phases skip re-emitting the clone-level seed messages
   * (Memory surfaced, Design memory, Seed:, Goal-gen pre-pass) because
   * those describe the shared clone and were already emitted by phase 0.
   * The sub-phase still receives the piped directive + prior transcript.
   */
  suppressSeedMessages?: boolean;
  /**
   * Task #36: app-level run id minted by the Orchestrator at run-start
   * (Unit 52d) and stashed into RunConfig here so runners can forward
   * it to their summary builders. Lets summary.json carry the same
   * runId the UI shows, so the history dropdown can render it as a
   * column and click-to-copy matches the live IdentityStrip chip.
   *
   * Not user-settable — the route schema doesn't accept this field;
   * Orchestrator.start overwrites any caller-provided value. Optional
   * on the type so tests that build bare RunConfigs stay valid.
   */
  runId?: string;
  /**
   * Phase 4a of #243: the explicit topology used for this run, set by
   * the route layer (synthesized from agentCount + per-role models
   * when the client didn't post one). Threaded into RunSummary so
   * History can show the exact agent specs and review-mode hydration
   * can recreate the grid as it was. Not consumed at runtime in
   * Phase 1 — the runners still use agentCount/plannerModel/etc. —
   * but Phase 2 will start consuming per-row model overrides.
   */
  topology?: import("../../../../shared/src/topology.js").Topology;
}
