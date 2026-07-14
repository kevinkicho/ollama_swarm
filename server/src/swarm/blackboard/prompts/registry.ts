// Prompt registry — lightweight snapshots of every prompt with behavior
// assertions. When a model changes, run the eval catalog against the
// current assertions to detect drift BEFORE production runs stall.
//
// Each entry has a version hash (update manually when the prompt changes)
// so git blame shows what changed and when.
//
// sourceFile paths:
//   - "prompts/<file>.ts" → relative to server/src/swarm/blackboard/
//   - anything else        → relative to server/src/swarm/
//
// Usage: npx tsx eval/run-eval.mjs --drift-check
//        (also wired from Orchestrator.start via driftGuard)

export interface PromptSnapshot {
  /** Stable identifier: "planner-parse-todos", "worker-hunks", etc. */
  name: string;
  /** Git sha or date of last prompt edit. Update manually on each change. */
  version: string;
  /** Which prompt variable this entry snapshots. */
  sourceFile: string;
  /** Assertions that must pass for the prompt to be considered valid.
   *  Each assertion is run against the model output after feeding this
   *  prompt.  All must pass. */
  expectedBehavior: string[];
  /** Which model this was last validated against. */
  lastValidatedModel: string;
  /** Unix ms timestamp of last validation. */
  lastValidatedAt: number;
}

/** Bumped when this registry's assertion set or coverage changes. */
const REGISTRY_VERSION = "2026-07-14";

export const promptRegistry: PromptSnapshot[] = [
  {
    name: "planner-todos",
    version: REGISTRY_VERSION,
    sourceFile: "prompts/planner.ts",
    expectedBehavior: [
      "prompt MUST mention 'description' as output field",
      "prompt MUST mention 'expectedFiles' as output field",
      "prompt MUST NOT contain '```json' (markdown fence — would cause format failure)",
      "prompt MUST NOT contain '<tool_call' (XML drift instruction — must remain prohibition)",
      "prompt MUST prohibit read-only TODOs (rule 5a: 'DO NOT emit read-only TODOs')",
      "prompt MUST require output is JSON array only (rule 1: 'Output ONLY a JSON array')",
      "prompt MUST mention 'imperative' (description style)",
    ],
    lastValidatedModel: "glm-5.1:cloud",
    lastValidatedAt: Date.UTC(2026, 6, 14),
  },
  {
    name: "worker-hunks",
    version: REGISTRY_VERSION,
    sourceFile: "prompts/worker.ts",
    expectedBehavior: [
      "prompt MUST mention 'hunks' as output array",
      "prompt MUST mention 'skip' as optional output field",
      "prompt MUST NOT contain '```json' (markdown fence)",
      "prompt MUST NOT contain '<tool_call' (XML drift)",
      "prompt MUST mention 'replace_between'",
      "prompt MUST mention 'replace'",
      "prompt MUST mention 'write'",
      "prompt MUST mention 'create'",
      "prompt MUST mention 'append'",
      "prompt MUST limit hunks to MAX_HUNKS (16)",
    ],
    lastValidatedModel: "gemma4:31b-cloud",
    lastValidatedAt: Date.UTC(2026, 6, 14),
  },
  {
    name: "auditor-verdict",
    version: REGISTRY_VERSION,
    sourceFile: "prompts/auditor.ts",
    expectedBehavior: [
      "prompt MUST mention 'verdicts' as output array",
      "prompt MUST NOT contain '```json' (markdown fence)",
      "prompt MUST NOT contain '<tool_call' (XML drift)",
      "prompt MUST mention 'already met or wont-do'",
      "prompt MUST mention 'c1, c2'",
      "prompt MUST mention 'WORKER CAPABILITIES'",
      "prompt MUST mention 'allowlisted'",
    ],
    lastValidatedModel: "deepseek-v4-flash:cloud",
    lastValidatedAt: Date.UTC(2026, 6, 14),
  },
  {
    name: "contract-criteria",
    version: REGISTRY_VERSION,
    sourceFile: "prompts/firstPassContract.ts",
    expectedBehavior: [
      "prompt MUST mention 'missionStatement'",
      "prompt MUST mention 'criteria'",
      "prompt MUST NOT contain '```json' (markdown fence)",
      "prompt MUST NOT contain '<tool_call' (XML drift)",
      "prompt MUST mention 'description'",
      "prompt MUST mention 'expectedFiles'",
    ],
    lastValidatedModel: "glm-5.1:cloud",
    lastValidatedAt: Date.UTC(2026, 6, 14),
  },
  {
    name: "replanner-todos",
    version: REGISTRY_VERSION,
    sourceFile: "prompts/replanner.ts",
    expectedBehavior: [
      "prompt MUST NOT contain '```json' (markdown fence)",
      "prompt MUST NOT contain '<tool_call' (XML drift)",
      "prompt MUST mention 'JSON_ONLY_FINAL_RULE_LINES'",
      "prompt MUST mention 'revised'",
    ],
    lastValidatedModel: "glm-5.1:cloud",
    lastValidatedAt: Date.UTC(2026, 6, 14),
  },
  {
    name: "verifier-review",
    version: REGISTRY_VERSION,
    sourceFile: "prompts/verifier.ts",
    expectedBehavior: [
      "prompt MUST NOT contain '```json' (markdown fence)",
      "prompt MUST NOT contain '<tool_call' (XML drift)",
      "prompt MUST mention 'JSON_ONLY_FINAL_RULE_LINES'",
      "prompt MUST mention 'verified'",
      "prompt MUST mention 'evidenceCitation'",
    ],
    lastValidatedModel: "glm-5.1:cloud",
    lastValidatedAt: Date.UTC(2026, 6, 14),
  },
  {
    name: "critic-review",
    version: REGISTRY_VERSION,
    sourceFile: "prompts/critic.ts",
    expectedBehavior: [
      "prompt MUST NOT contain '```json' (markdown fence)",
      "prompt MUST NOT contain '<tool_call' (XML drift)",
      "prompt MUST mention 'JSON_ONLY_FINAL_RULE_LINES'",
      "prompt MUST mention 'accept'",
      "prompt MUST mention 'reject'",
    ],
    lastValidatedModel: "glm-5.1:cloud",
    lastValidatedAt: Date.UTC(2026, 6, 14),
  },

  // ── Discussion / control critical paths (source under server/src/swarm/) ──
  {
    name: "council-findings",
    version: REGISTRY_VERSION,
    sourceFile: "councilPromptHelpers.ts",
    expectedBehavior: [
      "prompt MUST mention 'severity'",
      "prompt MUST NOT contain '```json'",
      "prompt MUST mention 'OUTPUT FORMAT'",
      "prompt MUST mention 'FIXING/ENHANCING'",
    ],
    lastValidatedModel: "deepseek-v4-flash:cloud",
    lastValidatedAt: Date.UTC(2026, 6, 14),
  },
  {
    name: "debate-judge-json",
    version: REGISTRY_VERSION,
    sourceFile: "debatePromptHelpers.ts",
    expectedBehavior: [
      "prompt MUST mention 'Output ONLY a JSON object'",
      "prompt MUST NOT contain '<tool_call'",
    ],
    lastValidatedModel: "deepseek-v4-flash:cloud",
    lastValidatedAt: Date.UTC(2026, 6, 14),
  },
  {
    name: "ow-lead-plan",
    version: REGISTRY_VERSION,
    sourceFile: "orchestratorWorkerPromptHelpers.ts",
    expectedBehavior: [
      "prompt MUST mention 'assignments'",
      "prompt MUST mention 'Output ONLY a JSON object'",
      "prompt MUST mention 'no markdown fences'",
    ],
    lastValidatedModel: "deepseek-v4-flash:cloud",
    lastValidatedAt: Date.UTC(2026, 6, 14),
  },
  {
    name: "best-of-n-judge",
    version: REGISTRY_VERSION,
    sourceFile: "bestOfNTurn.ts",
    expectedBehavior: [
      "prompt MUST mention 'pickedIndex'",
      "prompt MUST mention 'STRICT JSON'",
    ],
    lastValidatedModel: "deepseek-v4-flash:cloud",
    lastValidatedAt: Date.UTC(2026, 6, 14),
  },
  {
    name: "shared-json-snippets",
    version: REGISTRY_VERSION,
    sourceFile: "prompts/sharedSnippets.ts",
    expectedBehavior: [
      "prompt MUST mention 'Output ONLY valid JSON'",
      "prompt MUST mention 'markdown fences'",
      "prompt MUST mention 'MENTION_CONTRACT_NOTE'",
      "prompt MUST mention 'JSON_ONLY_FINAL_RULES'",
      "prompt MUST mention 'JSON_ARRAY_ONLY_LINE'",
    ],
    lastValidatedModel: "n/a-static",
    lastValidatedAt: Date.UTC(2026, 6, 14),
  },
  {
    name: "stigmergy-territory",
    version: REGISTRY_VERSION,
    sourceFile: "stigmergyPromptHelpers.ts",
    expectedBehavior: [
      "prompt MUST mention 'STRICT JSON'",
      "prompt MUST mention 'TERRITORY'",
      "prompt MUST mention 'no markdown fences'",
    ],
    lastValidatedModel: "deepseek-v4-flash:cloud",
    lastValidatedAt: Date.UTC(2026, 6, 14),
  },
  {
    name: "moa-aggregator",
    version: REGISTRY_VERSION,
    sourceFile: "moaPromptHelpers.ts",
    expectedBehavior: [
      "prompt MUST mention 'aggregator'",
      "prompt MUST mention 'proposers'",
    ],
    lastValidatedModel: "deepseek-v4-flash:cloud",
    lastValidatedAt: Date.UTC(2026, 6, 14),
  },
  {
    name: "map-reduce-mapper",
    version: REGISTRY_VERSION,
    sourceFile: "mapReducePromptHelpers.ts",
    expectedBehavior: [
      "prompt MUST mention 'slice'",
      "prompt MUST mention 'USER DIRECTIVE'",
    ],
    lastValidatedModel: "deepseek-v4-flash:cloud",
    lastValidatedAt: Date.UTC(2026, 6, 14),
  },
  {
    name: "council-todo-extract",
    version: REGISTRY_VERSION,
    sourceFile: "councilDecisions.ts",
    expectedBehavior: [
      "prompt MUST mention 'JSON_ARRAY_ONLY_LINE'",
      "prompt MUST mention 'ACTIONABLE'",
      "prompt MUST mention 'PARTITIONING'",
    ],
    lastValidatedModel: "deepseek-v4-flash:cloud",
    lastValidatedAt: Date.UTC(2026, 6, 14),
  },
];
