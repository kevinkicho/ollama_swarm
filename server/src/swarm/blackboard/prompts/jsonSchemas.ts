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

/** Mirrors `PlannerResponseSchema` in `planner.ts` — array of TODOs
 *  (max 5 per batch, MAX_TODOS_PER_BATCH). The discriminated union of
 *  hunks/build is encoded with `oneOf` since Ollama's format accepts
 *  any JSON Schema. Constrains the planner's per-cycle TODO emission
 *  so it can't emit prose preamble or XML markers. */
export const PLANNER_TODOS_JSON_SCHEMA = {
  type: "array",
  minItems: 0,
  maxItems: 5,
  items: {
    oneOf: [
      // hunks variant (default)
      {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["hunks"] },
          description: { type: "string", minLength: 1, maxLength: 500 },
          expectedFiles: {
            type: "array",
            minItems: 1,
            maxItems: 2,
            items: { type: "string", minLength: 1 },
          },
          expectedAnchors: {
            type: "array",
            maxItems: 4,
            items: { type: "string", minLength: 1 },
          },
          expectedSymbols: {
            type: "array",
            maxItems: 4,
            items: { type: "string", minLength: 1 },
          },
          preferredTag: { type: "string", maxLength: 40 },
        },
        required: ["description", "expectedFiles"],
      },
      // build variant (#237) — runs a shell command via swarm-builder agent
      {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["build"] },
          description: { type: "string", minLength: 1, maxLength: 500 },
          expectedFiles: {
            type: "array",
            minItems: 1,
            maxItems: 2,
            items: { type: "string", minLength: 1 },
          },
          command: { type: "string", minLength: 1, maxLength: 500 },
          expectedAnchors: {
            type: "array",
            maxItems: 4,
            items: { type: "string", minLength: 1 },
          },
          expectedSymbols: {
            type: "array",
            maxItems: 4,
            items: { type: "string", minLength: 1 },
          },
          preferredTag: { type: "string", maxLength: 40 },
        },
        required: ["kind", "description", "expectedFiles", "command"],
      },
    ],
  },
} as const;

/** Mirrors `AuditorResponseSchema` in `auditor.ts`. Constrains the
 *  per-criterion verdicts + optional new-criteria emission. Pre-fix,
 *  the auditor sometimes emitted prose ("Looking at the verdicts...")
 *  or wrapped the response in markdown fences — both go away. */
export const AUDITOR_VERDICT_JSON_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      minItems: 0,
      maxItems: 20,
      items: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1, maxLength: 64 },
          status: { type: "string", enum: ["met", "wont-do", "unmet"] },
          rationale: { type: "string", minLength: 1, maxLength: 800 },
          todos: {
            type: "array",
            maxItems: 4,
            items: {
              type: "object",
              properties: {
                description: { type: "string", minLength: 1, maxLength: 500 },
                expectedFiles: {
                  type: "array",
                  minItems: 1,
                  maxItems: 2,
                  items: { type: "string", minLength: 1 },
                },
              },
              required: ["description", "expectedFiles"],
            },
          },
        },
        required: ["id", "status", "rationale"],
      },
    },
    newCriteria: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          description: { type: "string", minLength: 1, maxLength: 400 },
          expectedFiles: {
            type: "array",
            minItems: 0,
            maxItems: 4,
            items: { type: "string", minLength: 1 },
          },
        },
        required: ["description", "expectedFiles"],
      },
    },
  },
  required: ["verdicts"],
} as const;

/** Mirrors `CriticResponseSchema` in `critic.ts`. Tiny envelope —
 *  verdict + rationale. The constraint is mostly value: the critic
 *  fires per commit (potentially every 30s), so even small JSON-repair
 *  retries add up. Pinning the shape eliminates them. */
export const CRITIC_ENVELOPE_JSON_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["accept", "reject"] },
    rationale: { type: "string", minLength: 1, maxLength: 400 },
  },
  required: ["verdict", "rationale"],
} as const;

/** Mirrors `WorkerResponseSchema` in `worker.ts` — the highest-frequency
 *  parse-failure path in the system because workers emit complex multi-
 *  line search/replace strings. Discriminated union via `oneOf` covers
 *  the three hunk variants (replace / create / append).
 *
 *  Cap of 8 hunks per response matches MAX_HUNKS. Search/replace cap
 *  at 50K, content cap at 200K — same as the zod schema. The schema
 *  optionally accepts a `skip` field; when present, the runner treats
 *  the response as "worker declined this todo with reason X." */
export const WORKER_HUNKS_JSON_SCHEMA = {
  type: "object",
  properties: {
    hunks: {
      type: "array",
      maxItems: 8,
      items: {
        oneOf: [
          // replace variant: { op: "replace", file, search, replace }
          {
            type: "object",
            properties: {
              op: { type: "string", enum: ["replace"] },
              file: { type: "string", minLength: 1, maxLength: 1000 },
              search: { type: "string", minLength: 1, maxLength: 50_000 },
              replace: { type: "string", maxLength: 50_000},
            },
            required: ["op", "file", "search", "replace"],
          },
          // create variant: { op: "create", file, content }
          {
            type: "object",
            properties: {
              op: { type: "string", enum: ["create"] },
              file: { type: "string", minLength: 1, maxLength: 1000 },
              content: { type: "string", maxLength: 200_000 },
            },
            required: ["op", "file", "content"],
          },
          // append variant: { op: "append", file, content }
          {
            type: "object",
            properties: {
              op: { type: "string", enum: ["append"] },
              file: { type: "string", minLength: 1, maxLength: 1000 },
              content: { type: "string", minLength: 1, maxLength: 200_000 },
            },
            required: ["op", "file", "content"],
          },
        ],
      },
    },
    skip: { type: "string", minLength: 1, maxLength: 500 },
  },
  required: ["hunks"],
} as const;
