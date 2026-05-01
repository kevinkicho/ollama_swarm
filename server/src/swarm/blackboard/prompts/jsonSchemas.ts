// JSON Schema constants for Ollama's `format` constrained-decoding
// parameter. Hand-written (not auto-generated from the zod schemas next
// door) for two reasons:
//
//   1. No new npm dep. zod-to-json-schema works fine but adds a
//      ~50KB transitive surface for ~70 lines of hand-rolled JSON.
//   2. The constrained-decoding schema can be *tighter* than the
//      parser's. The parser tolerates extra-loose inputs and dispatches
//      to repair prompts; the decoder benefits from the strictest shape
//      we can describe so the model never wanders into prose preamble.
//
// When the zod schema next door changes, update the corresponding JSON
// schema below in the same PR. The `parseFirstPassContractResponse` /
// `parsePlannerResponse` tests will catch shape mismatches at the
// runtime parse layer; the schema tests below catch them at module
// load.

/** Mirrors `ContractSchema` in `firstPassContract.ts`. Constrains the
 *  planner's first-pass exit contract emission to a missionStatement +
 *  array of criteria with expectedFiles. Pre-2026-05-01 the planner
 *  could emit XML pseudo-tool-call markers, prose preambles, or just
 *  bail mid-envelope; constrained decoding eliminates all three. */
export const CONTRACT_JSON_SCHEMA = {
  type: "object",
  properties: {
    missionStatement: {
      type: "string",
      minLength: 1,
      maxLength: 500,
    },
    criteria: {
      type: "array",
      minItems: 0,
      maxItems: 12,
      items: {
        type: "object",
        properties: {
          description: {
            type: "string",
            minLength: 1,
            maxLength: 400,
          },
          expectedFiles: {
            type: "array",
            minItems: 0,
            maxItems: 4,
            items: {
              type: "string",
              minLength: 1,
            },
          },
        },
        required: ["description", "expectedFiles"],
      },
    },
  },
  required: ["missionStatement", "criteria"],
} as const;
