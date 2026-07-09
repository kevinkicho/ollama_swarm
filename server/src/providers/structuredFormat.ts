// Provider-specific structured-output bodies for emit-only planner calls.
// Callers pass ChatOpts.format as "json" or a JSON Schema object (from jsonSchemas.ts).

import type { ChatOpts } from "./SessionProvider.js";

export const ANTHROPIC_STRUCTURED_OUTPUTS_BETA = "structured-outputs-2025-11-01";

/** OpenAI / chat-completions response_format fragment. */
export function openAiResponseFormatBody(
  format: ChatOpts["format"],
  schemaName = "emit_response",
): Record<string, unknown> | undefined {
  if (!format) return undefined;
  if (format === "json") {
    return { response_format: { type: "json_object" } };
  }
  if (typeof format === "object") {
    const f = format as Record<string, unknown>;
    if (
      f.type === "json_object"
      || f.type === "json_schema"
      || f.type === "text"
      || f.type === "regex"
    ) {
      return { response_format: f };
    }
    return {
      response_format: {
        type: "json_schema",
        json_schema: {
          name: schemaName,
          strict: true,
          schema: format,
        },
      },
    };
  }
  return undefined;
}

/** Anthropic Messages API output_format fragment + beta header value. */
export function anthropicStructuredBody(
  format: ChatOpts["format"],
): { output_format: Record<string, unknown>; beta: string } | undefined {
  if (!format) return undefined;
  if (format === "json") {
    return {
      output_format: { type: "json_schema", schema: { type: "object" } },
      beta: ANTHROPIC_STRUCTURED_OUTPUTS_BETA,
    };
  }
  if (typeof format === "object") {
    const f = format as Record<string, unknown>;
    if (f.type === "json_schema" && "schema" in f) {
      return { output_format: f, beta: ANTHROPIC_STRUCTURED_OUTPUTS_BETA };
    }
    return {
      output_format: { type: "json_schema", schema: format },
      beta: ANTHROPIC_STRUCTURED_OUTPUTS_BETA,
    };
  }
  return undefined;
}

/**
 * Structured emit format is only applied on tool-free calls (swarm emit profile).
 * Tool loops cannot reliably combine function tools + json_schema on all providers.
 */
export function structuredFormatForChat(
  opts: ChatOpts,
  schemaName?: string,
): {
  openAi?: Record<string, unknown>;
  anthropic?: { output_format: Record<string, unknown>; beta: string };
} {
  const toolsActive = !!(opts.tools && opts.tools.length > 0 && opts.dispatcher);
  if (!opts.format || toolsActive) return {};
  return {
    openAi: openAiResponseFormatBody(opts.format, schemaName),
    anthropic: anthropicStructuredBody(opts.format),
  };
}