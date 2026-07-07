// AI brain fallback parser.
//
// When a model's output fails Zod validation (even after lenient pre-processing),
// instead of discarding the response entirely, we send it to a lightweight "brain"
// model that interprets the raw output and extracts structured JSON matching the
// expected schema shape.
//
// Design principles:
//   1. The brain model is NOT a judge of quality — it's a decoder. Its job is
//      purely structural: "this text was supposed to be JSON shape X; extract X
//      from it."
//   2. Brain invocation is a LAST resort, not a first resort. The rule-based
//      lenient parser (truncate/slice) runs first; only when that fails does
//      the brain kick in.
//   3. Brain calls are logged as `brain-fallback` events so post-run analysis
//      can identify common failure patterns and propose parser updates.
//   4. The brain model is user-configurable via SWARM_BRAIN_MODEL env var.
//      Default: gemma4:31b-cloud (lightweight, fast, good at JSON extraction).
//   5. Brain calls have a tight timeout (15s) — if the brain can't extract
//      structured data in 15s, the original parse failure stands.

import { z } from "zod";
import { extractJsonFromText } from "../../extractJson.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface BrainConfig {
  /** Model string for the brain LLM. Default: "gemma4:31b-cloud" */
  brainModel: string;
  /** Max time to wait for a brain response (ms). Default: 15000 */
  timeoutMs: number;
  /** Max tokens the brain can generate. Default: 4096 */
  maxTokens: number;
}

export const DEFAULT_BRAIN_CONFIG: BrainConfig = {
  brainModel: "gemma4:31b-cloud",
  timeoutMs: 15_000,
  maxTokens: 4096,
};

// ---------------------------------------------------------------------------
// Brain fallback event (for logging / post-run analysis)
// ---------------------------------------------------------------------------

export interface BrainFallbackEvent {
  /** Which parser called the brain (e.g. "planner", "auditor") */
  parser: string;
  /** The original parse failure reason */
  originalError: string;
  /** First 500 chars of the raw model output that failed parsing */
  rawSnippet: string;
  /** Whether the brain successfully extracted valid JSON */
  brainSuccess: boolean;
  /** If brain succeeded, which fields it had to fix/interpret */
  fieldsFixed?: string[];
  /** Time the brain call took (ms) */
  durationMs: number;
  /** Model used for the brain call */
  brainModel: string;
}

// ---------------------------------------------------------------------------
// Brain prompt construction
// ---------------------------------------------------------------------------

export function buildBrainPrompt(
  rawOutput: string,
  schemaDescription: string,
  parserName: string,
): string {
  // Truncate raw output to avoid exceeding context limits. The brain only
  // needs enough to understand the structure — for a 50KB worker response
  // that's mostly file contents, the first 8KB is plenty.
  const maxSnippet = 8192;
  const snippet = rawOutput.length > maxSnippet
    ? rawOutput.slice(0, maxSnippet) + "\n... (truncated)"
    : rawOutput;

  return [
    `You are a JSON extraction assistant. A ${parserName} agent produced output that failed structured parsing.`,
    "",
    "The output was supposed to conform to this schema:",
    schemaDescription,
    "",
    "Here is the raw output:",
    "```",
    snippet,
    "```",
    "",
    "Extract the structured data from this output. Output ONLY valid JSON conforming to the schema. Do NOT add commentary, markdown fences, or any text outside the JSON object/array.",
    "",
    "If the output is fundamentally unparseable (not structured data at all, just prose), respond with: {\"_brain_unparseable\": true}",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Schema descriptions (lightweight — just enough for the brain to understand)
// ---------------------------------------------------------------------------

export const SCHEMA_DESCRIPTIONS: Record<string, string> = {
  planner: `Array of TODO objects: [{ "description": string(max500), "expectedFiles": [string(max2)], "expectedAnchors": [string]?, "expectedSymbols": [string]?, "kind": "hunks"|"build"?, "command": string(when kind=build)? }]`,
  contract: `{ "missionStatement": string(max500), "criteria": [{ "description": string(max400), "expectedFiles": [string(max4)] }] }`,
  auditor: `{ "verdicts": [{ "id": string, "status": "met"|"wont-do"|"unmet", "rationale": string(max800), "todos": [{ "description": string(max500), "expectedFiles": [string(max2)] }]? }], "newCriteria": [{ "description": string(max400), "expectedFiles": [string(max4)] }]? }`,
  worker: `{ "hunks": [{ "op": "replace"|"create"|"append", "file": string, "search": string(when replace), "replace": string(when replace), "content": string(when create|append) }], "skip": string? }`,
  verifier: `{ "verdict": "verified"|"partial"|"false"|"unverifiable", "evidenceCitation": string(max500), "rationale": string(max400)? }`,
  replanner: `Either { "revised": { "description": string, "expectedFiles": [string], "kind": "build"?, "command": string?(when kind=build), "expectedAnchors": [string]? } } or { "skip": true, "reason": string }`,
  "hunk-review": `{ "approve": boolean, "reason": string }`,
  critic: `{ "verdict": "accept"|"reject", "rationale": string(max400) }`,
};

// ---------------------------------------------------------------------------
// Core brain parser
// ---------------------------------------------------------------------------

export interface BrainParseResult<T> {
  data: T;
  /** Fields the brain had to fix/interpret from the raw output */
  fieldsFixed: string[];
}

/**
 * Attempt to parse rawOutput using the brain model.
 *
 * Returns `{ data, fieldsFixed }` on success, or `null` on failure
 * (brain unparseable, brain output not valid JSON, or brain JSON
 * doesn't match the Zod schema).
 */
export function parseBrainOutput<T>(
  rawBrainOutput: string,
  schema: z.ZodType<T>,
): BrainParseResult<T> | null {
  // Check for the "unparseable" sentinel
  if (rawBrainOutput.trim() === '{"_brain_unparseable": true}') {
    return null;
  }

  // Try to extract JSON from the brain's output (it might wrap in fences)
  let jsonStr: string | null = rawBrainOutput.trim();
  try {
    JSON.parse(jsonStr);
  } catch {
    jsonStr = extractJsonFromText(rawBrainOutput);
    if (jsonStr === null) return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  // Check for unparseable sentinel
  if (
    typeof parsed === "object" && parsed !== null &&
    "_brain_unparseable" in parsed
  ) {
    return null;
  }

  // Validate against the Zod schema
  const result = schema.safeParse(parsed);
  if (!result.success) return null;

  return { data: result.data, fieldsFixed: [] };
}

// ---------------------------------------------------------------------------
// Brain invoker (calls the LLM)
// ---------------------------------------------------------------------------

export type BrainPromptFn = (prompt: string, model: string, maxTokens: number, timeoutMs: number, agent?: import("../../../services/AgentManager.js").Agent) => Promise<string>;

/**
 * High-level brain fallback: given a raw failed output, a Zod schema,
 * and a parser name, try to extract structured data using the brain model.
 *
 * Returns parsed data on success, null on failure. Always logs a
 * BrainFallbackEvent via the provided callback.
 */
export async function brainFallbackParse<T>(
  rawOutput: string,
  schema: z.ZodType<T>,
  parserName: string,
  cfg: BrainConfig,
  promptFn: BrainPromptFn,
  onEvent: (event: BrainFallbackEvent) => void,
  agent?: import("../../../services/AgentManager.js").Agent,
): Promise<T | null> {
  const schemaDesc = SCHEMA_DESCRIPTIONS[parserName];
  if (!schemaDesc) return null;

  const prompt = buildBrainPrompt(rawOutput, schemaDesc, parserName);
  const start = Date.now();
  let brainSuccess = false;
  let fieldsFixed: string[] | undefined;

  try {
    const brainOutput = await promptFn(prompt, cfg.brainModel, cfg.maxTokens, cfg.timeoutMs, agent);
    const result = parseBrainOutput(brainOutput, schema);
    if (result) {
      brainSuccess = true;
      fieldsFixed = result.fieldsFixed;
      return result.data;
    }
    return null;
  } catch {
    return null;
  } finally {
    onEvent({
      parser: parserName,
      originalError: "(rule-based parse failed)",
      rawSnippet: rawOutput.slice(0, 500),
      brainSuccess,
      fieldsFixed,
      durationMs: Date.now() - start,
      brainModel: cfg.brainModel,
    });
  }
}