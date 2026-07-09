// Single source of truth for model resolution across the entire swarm pipeline.
//
// Problem: models were resolved at 31 decision points across 15 files with
// duplicated defaults, scattered ?? chains, and no single authority. This file
// defines one pure function that takes user input + config defaults and returns
// the final resolved models. Every consumer (route, orchestrator, runners) uses
// this result — no more independent fallback chains.
//
// Architecture:
//   resolveModels(body, defaults) → { model, plannerModel, workerModel, auditorModel }
//
// Rules (in priority order):
//   1. Per-role explicit field (plannerModel / workerModel / auditorModel) wins
//   2. Topology per-agent model override (extracted via deriveLegacyFields) wins
//      over defaults but NOT over explicit fields
//   3. model (top-level) is the catch-all fallback for any unset per-role field
//   4. config defaults are the last resort (DEFAULT_MODEL, DEFAULT_WORKER_MODEL, etc.)
//
// One-line mental model: explicit > topology > model > default

import { resolveModelForAgent } from "./providers.js";
import { deriveLegacyFields, type Topology } from "./topology.js";

export { resolveModelForAgent } from "./providers.js";

/** Resolve spawn model for a topology index (1-based agent index). */
export function resolveModelForTopologyIndex(
  topology: Topology | undefined,
  index: number,
  roleFallback: string,
): string {
  const spec = topology?.agents.find((a) => a.index === index);
  if (!spec) return roleFallback;
  return resolveModelForAgent(spec, roleFallback);
}

export interface ModelConfig {
  /** The user's top-level model selection — the catch-all. */
  model: string;
  /** Resolved planner model — never undefined after resolution. */
  plannerModel: string;
  /** Resolved worker model — never undefined after resolution. */
  workerModel: string;
  /** Resolved auditor model — never undefined after resolution. */
  auditorModel: string;
}

export interface ModelDefaults {
  /** Fallback when nothing else is set (from env DEFAULT_MODEL). */
  model: string;
  /** Blackboard-only worker default (from env DEFAULT_WORKER_MODEL). */
  workerModel: string;
  /** Blackboard-only auditor default (from env DEFAULT_AUDITOR_MODEL). */
  auditorModel: string;
  /** Whether blackboard spawns a dedicated auditor by default. */
  dedicatedAuditor: boolean;
}

export interface ModelResolutionInput {
  /** The user's top-level model selection. May be empty/unset. */
  model?: string;
  /** Explicit per-role overrides from the form. */
  plannerModel?: string;
  workerModel?: string;
  auditorModel?: string;
  /** Topology from the form — per-agent model overrides. */
  topology?: Topology;
  /** Preset name — used to determine blackboard-specific defaults. */
  preset: string;
  /** Whether the user explicitly enabled dedicated auditor. */
  dedicatedAuditor?: boolean;
}

/**
 * Pure function: resolves all models from user input + defaults into a single
 * coherent ModelConfig. Call once at the route layer; pass the result through
 * to the orchestrator and runners.
 */
export function resolveModels(
  input: ModelResolutionInput,
  defaults: ModelDefaults,
): ModelConfig {
  const isBlackboard = input.preset === "blackboard";
  const dedicatedAuditor =
    input.dedicatedAuditor ?? (isBlackboard ? defaults.dedicatedAuditor : false);

  // Extract topology-derived models (only used as fallback when explicit
  // per-role fields are absent — the user's explicit plannerModel wins over
  // whatever was set in the topology grid).
  const topologyFields = input.topology
    ? deriveLegacyFields(input.topology, input.preset)
    : null;

  // Fallback chains (first non-empty wins). Each role has a different chain
  // because the original behavior was different per role:
  //   planner: explicit → topology → model → default
  //   worker:  explicit → topology → roleDefault → model → default
  //   auditor: explicit → topology → roleDefault → model → default
  //
  // Use ?? instead of || — empty string "" is a valid model name in some
  // edge cases and should not be silently skipped as "unset."
  const pick = (
    explicit: string | undefined,
    topologyOverride: string | undefined,
    roleDefault?: string,
  ): string => {
    return explicit ?? topologyOverride ?? roleDefault ?? input.model ?? defaults.model;
  };

  // Planner: no role default (model IS the default for planner/orchestrator)
  const pickPlanner = (
    explicit: string | undefined,
    topologyOverride: string | undefined,
  ): string => {
    return explicit ?? topologyOverride ?? input.model ?? defaults.model;
  };

  return {
    model: input.model ?? defaults.model,
    plannerModel: pickPlanner(input.plannerModel, topologyFields?.plannerModel),
    workerModel: pick(
      input.workerModel,
      topologyFields?.workerModel,
      isBlackboard ? defaults.workerModel : undefined,
    ),
    auditorModel: pick(
      input.auditorModel,
      topologyFields?.auditorModel,
      isBlackboard && dedicatedAuditor ? defaults.auditorModel : undefined,
    ),
  };
}
