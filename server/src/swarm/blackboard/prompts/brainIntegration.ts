// Integration layer: wires the brain parser into the existing prompt runners.
//
// Usage: after any rule-based parser (planner, auditor, etc.) returns
// `{ ok: false, reason }`, call `tryBrainFallback` with the parser name,
// raw output, Zod schema, and context. If the brain succeeds, you get
// valid data back; otherwise the original parse failure stands.
//
// The brain is ONLY invoked when:
//   1. The rule-based parser (including lenient extraction) has already failed
//   2. SWARM_BRAIN_MODEL is non-empty (default: "gemma4:31b-cloud")
//   3. A prompt function is available (injected by the runner)
//
// Brain events are always logged regardless of outcome, providing data
// for post-run parser improvement proposals.

import { z } from "zod";
import { config } from "../../../config.js";
import {
  brainFallbackParse,
  DEFAULT_BRAIN_CONFIG,
  SCHEMA_DESCRIPTIONS,
  type BrainConfig,
  type BrainFallbackEvent,
  type BrainPromptFn,
} from "./brainParser.js";

// Re-export for direct use
export type { BrainFallbackEvent, BrainConfig };

// ---------------------------------------------------------------------------
// Schema map — each parser's Zod schema, keyed by name
// ---------------------------------------------------------------------------

// Schemas are registered by the parser modules at import time.
// This avoids circular imports (parsers import brainIntegration to
// report fallbacks, brainIntegration imports parser schemas).
const parserSchemas = new Map<string, z.ZodType<unknown>>();

export function registerParserSchema(name: string, schema: z.ZodType<unknown>): void {
  parserSchemas.set(name, schema);
}

export function getParserSchema(name: string): z.ZodType<unknown> | undefined {
  return parserSchemas.get(name);
}

// ---------------------------------------------------------------------------
// Brain-on configuration
// ---------------------------------------------------------------------------

/** Check if brain fallback is enabled (non-empty SWARM_BRAIN_MODEL). */
export function brainEnabled(): boolean {
  return config.SWARM_BRAIN_MODEL.length > 0;
}

/** Build a BrainConfig from app config, with an optional per-run model override. */
export function brainConfigFromApp(runModel?: string): BrainConfig {
  return {
    ...DEFAULT_BRAIN_CONFIG,
    brainModel: runModel && runModel.length > 0
      ? runModel
      : config.SWARM_BRAIN_MODEL || DEFAULT_BRAIN_CONFIG.brainModel,
  };
}

// ---------------------------------------------------------------------------
// Convenience: try brain fallback for a specific parser
// ---------------------------------------------------------------------------

/**
 * Attempt brain fallback parsing after a rule-based parser has failed.
 *
 * @param parserName - One of "planner", "contract", "auditor", "worker",
 *   "verifier", "replanner", "critic"
 * @param rawOutput - The raw model output that failed rule-based parsing
 * @param schema - The Zod schema to validate against
 * @param promptFn - Function to call the brain model
 * @param onEvent - Callback for logging/observability
 * @returns Parsed data on success, null on failure
 */
export async function tryBrainFallback<T>(
  parserName: string,
  rawOutput: string,
  schema: z.ZodType<T>,
  promptFn: BrainPromptFn,
  onEvent: (event: BrainFallbackEvent) => void,
  agent?: import("../../services/AgentManager.js").Agent,
): Promise<T | null> {
  if (!brainEnabled()) return null;
  if (!SCHEMA_DESCRIPTIONS[parserName]) return null;

  const cfg = brainConfigFromApp(agent?.model);
  return brainFallbackParse(rawOutput, schema, parserName, cfg, promptFn, onEvent, agent);
}