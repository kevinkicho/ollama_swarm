// Partial RunConfig fields — RunConfigModels
export interface RunConfigModels {
  /**
   * Unit 42: per-agent model overrides. When set, the planner agent
   * (and the planner-hosted critic / replanner / auditor sessions)
   * uses `plannerModel`, while worker agents use `workerModel`. Each
   * falls back to `model` when absent — so existing single-model
   * runs are unchanged. Both blackboard-only (other presets ignore
   * these and use `model` for every agent).
   *
   * Use case: heavy-lift cloud model for planning + verification
   * (e.g. `glm-5.1:cloud`), cheaper / faster model for high-volume
   * worker turns (e.g. `gemma4:31b-cloud`).
   */
  plannerModel?: string;
  workerModel?: string;
  /**
   * Legacy — in-run brain parse fallback is retired. Ignored at runtime.
   * Post-run brainOverseer analysis uses its own model config.
   */
  brainModel?: string;
  /**
   * Unit 58: per-run model override for the auditor agent (when
   * dedicatedAuditor=true). Falls back to plannerModel, then to
   * model. Useful when you want a smaller/faster model for audit
   * (it's diff/criteria reasoning — doesn't need the planner's
   * design taste). Ignored when dedicatedAuditor is false.
   */
  auditorModel?: string;
  /**
   * #98 (2026-05-01): heterogeneous models per MoA layer. The whole
   * point of MoA per the original Together AI paper is that N small
   * fast models proposing + 1 big reasoning model aggregating beats
   * any single model alone. Without per-layer models, both layers use
   * cfg.model and the test is contaminated.
   *
   * - moaProposerModel: model used for the N proposers in Layer 1
   *   (cheap + fast, e.g. gemma4:31b-cloud)
   * - moaAggregatorModel: model used for the K aggregators in Layer 2
   *   (slower + smarter, e.g. deepseek-v4-flash:cloud or sonnet)
   *
   * Each falls back to cfg.model when absent — preserves single-model
   * behavior. MoA-only.
   */
  moaProposerModel?: string;
  moaAggregatorModel?: string;
  /**
   * T196 (2026-05-04): heterogeneous proposers UI substrate. When set,
   * each proposer N uses moaProposerModels[N % length] instead of the
   * single moaProposerModel. The whole point of MoA is N DIFFERENT
   * small models proposing — beats N copies of the same model. The
   * UI surface is deferred (per-proposer dropdown form work); use
   * via API for now.
   *
   * Examples (per the original Together AI paper):
   *   ["gemma4:31b-cloud", "qwen3-coder-next:cloud", "deepseek-v4-flash:cloud"]
   *   ["llama3:8b", "mistral-large-3:7b", "qwen2.5-coder:7b"]
   *
   * Falls back to moaProposerModel → cfg.model when absent.
   * MoA-only.
   */
  moaProposerModels?: readonly string[];
  /**
   * T196 (2026-05-04): per-tier model routing for OW-Deep. Each tier
   * uses a different model: orchestrator (strategy / reasoning),
   * mid-leads (tactics / reasoning), workers (implementation /
   * coding-tier). Same value-prop as MoA's heterogeneous proposers
   * but at the OW-Deep tier boundary. Existing cfg.workerModel
   * already exists (also used by blackboard); this adds the orch +
   * mid-lead tiers.
   *
   * Example:
   *   orchestratorModel: "deepseek-v4-flash:cloud"  // strategy
   *   midLeadModel: "glm-5.1:cloud"                // tactics
   *   workerModel: "gemma4:31b-cloud"              // implementation
   *
   * Each falls back to cfg.model when absent. OW-Deep only.
   * The UI surface is deferred (per-tier dropdown form work).
   */
  orchestratorModel?: string;
  midLeadModel?: string;
  /** T-Item-AutoRoute (2026-05-04): runtime per-prompt model routing.
   *  When true, runners that normally fan all agents through cfg.model
   *  consult per-tier overrides on a per-prompt basis using the role
   *  category (planner / worker / auditor / judge). Lets a user run
   *  cfg.workerModel: "gemma4:31b-cloud" + cfg.plannerModel:
   *  "glm-5.1:cloud" without having to set per-agent overrides.
   *  Default OFF — preserves the legacy "one model for everything"
   *  shape. Currently honored by: orchestrator-worker, map-reduce
   *  (other runners adopt incrementally; the helper is shared). */
  dynamicModelRoute?: boolean;
  /**
   * T193 (2026-05-04): per-disposition model routing for round-robin
   * (no-roles variant). Maps each disposition to a model id; the
   * runner uses promptWithRetry's modelOverride to call that model
   * for the disposition's turns. Plays to the open-weights-
   * parallelism value prop — Critic/Gap-finder benefit from a
   * reasoning-tier model while Builder/Synthesizer benefit from a
   * coding-tier (faster, cheaper). Default off (every disposition
   * uses cfg.model). Round-robin only.
   *
   * Example:
   *   { critic: "deepseek-v4-flash:cloud",
   *     "gap-finder": "deepseek-v4-flash:cloud",
   *     synthesizer: "glm-5.1:cloud",
   *     builder: "gemma4:31b-cloud" }
   */
  dispositionModels?: {
    critic?: string;
    synthesizer?: string;
    "gap-finder"?: string;
    builder?: string;
  };
  /**
   * Model for the write phase when writeMode !== "none". Falls back to
   * cfg.model when absent. Useful when you want a cheaper/faster model
   * for the discussion phase but a capable model for hunk generation.
   * Ignored when writeMode is "none" or absent.
   */
  writeModel?: string;
  /**
   * Issue #3 (2026-04-27): override the sibling-model used when the
   * planner returns 0 valid todos. Absent → look up sibling from the
   * hardcoded REASONING-tier pair (deepseek↔nemotron). Set explicitly
   * to use a different model (e.g. "glm-5.1:cloud") when neither
   * sibling-tier model fits. Set to the same value as `plannerModel`
   * to effectively disable fallback. Blackboard-only.
   */
  plannerFallbackModel?: string;
}
