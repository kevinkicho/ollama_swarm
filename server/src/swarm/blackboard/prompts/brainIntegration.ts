// Legacy integration layer for the retired in-run brain parse fallback.
// In-run parsing is handled by swarm agents only (repair → auditor
// interpretation → sibling-retry). Post-run analysis uses brainOverseer.
// tryBrainFallback remains for tests/tooling but brainEnabled() is false.

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

/** In-run parse fallback is retired — brain is post-run system analysis only. */
export function brainEnabled(): boolean {
  return false;
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
  agent?: import("../../../services/AgentManager.js").Agent,
): Promise<T | null> {
  if (!brainEnabled()) return null;
  if (!SCHEMA_DESCRIPTIONS[parserName]) return null;

  const cfg = brainConfigFromApp(agent?.model);
  return brainFallbackParse(rawOutput, schema, parserName, cfg, promptFn, onEvent, agent);
}