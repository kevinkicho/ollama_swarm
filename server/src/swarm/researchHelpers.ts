// Research helpers: utilities for web/research-oriented runs.
// Carved out to support scientific use cases (literature, data discovery)
// and keep Orchestrator / provisioner lean.

import type { RunConfig } from "./RunConfig.js";

export interface ResearchConfigOptions {
  enableWebByDefault?: boolean;
}

/**
 * Prepares a RunConfig for research use cases.
 * - Enables webTools + plannerTools if not set.
 * - Suggests hybrid council planning for complex research.
 * Used by Brain provisioner and Orchestrator startup.
 */
export function prepareResearchConfig(cfg: RunConfig, opts: ResearchConfigOptions = {}): RunConfig {
  const out = { ...cfg };

  const looksResearch = !!(cfg.userDirective && /research|literature|scientific|study|paper|superconductor|data endpoint|web search/i.test(cfg.userDirective));

  if (looksResearch || opts.enableWebByDefault) {
    if (out.webTools === undefined) out.webTools = true;
    if (out.plannerTools === undefined) out.plannerTools = true;
  }

  // For hybrid research flows, ensure sensible defaults if user set useHybridPlanning
  if (out.useHybridPlanning && !out.planningPreset) {
    out.planningPreset = "council";
  }
  if (out.useHybridPlanning && !out.executionPreset) {
    out.executionPreset = "blackboard";
  }

  return out;
}

/**
 * Returns whether a config is research-flagged (for Brain categorization, prompts, etc.).
 */
export function isResearchRun(cfg: RunConfig): boolean {
  if (cfg.webTools || cfg.plannerTools) return true;
  const d = (cfg.userDirective || "").toLowerCase();
  return /research|literature|scientific|study|superconductor|arxiv|paper/i.test(d);
}
