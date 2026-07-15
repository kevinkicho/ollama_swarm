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
// Prefer needles that appear in *emitted* prompt text (or expanded exports).
// Identifier-only checks (e.g. import names) are secondary.
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
const REGISTRY_VERSION = "2026-07-15";

export const promptRegistry: PromptSnapshot[] = [
  {
    name: "planner-todos",
    version: REGISTRY_VERSION,
    sourceFile: "prompts/planner.ts",
    expectedBehavior: [
      "prompt MUST mention 'description'",
      "prompt MUST mention 'expectedFiles'",
      "prompt MUST NOT contain '```json' (markdown fence — would cause format failure)",
      "prompt MUST NOT contain '<tool_call' (XML drift instruction — must remain prohibition)",
      "prompt MUST prohibit read-only TODOs (rule 5a: 'DO NOT emit read-only TODOs')",
      "prompt MUST mention 'Output ONLY valid JSON'",
      "prompt MUST mention 'JSON array of todos'",
      "prompt MUST mention 'imperative'",
    ],
    lastValidatedModel: "glm-5.1:cloud",
    lastValidatedAt: Date.UTC(2026, 6, 15),
  },
  {
    name: "worker-hunks",
    version: REGISTRY_VERSION,
    sourceFile: "prompts/worker.ts",
    expectedBehavior: [
      "prompt MUST mention 'hunks'",
      "prompt MUST mention 'skip'",
      "prompt MUST NOT contain '```json' (markdown fence)",
      "prompt MUST NOT contain '<tool_call' (XML drift)",
      "prompt MUST mention 'Output ONLY valid JSON'",
      "prompt MUST mention 'replace_between'",
      "prompt MUST mention 'replace'",
      "prompt MUST mention 'write'",
      "prompt MUST mention 'create'",
      "prompt MUST mention 'append'",
      "prompt MUST limit hunks to MAX_HUNKS (16)",
    ],
    lastValidatedModel: "gemma4:31b-cloud",
    lastValidatedAt: Date.UTC(2026, 6, 15),
  },
  {
    name: "auditor-verdict",
    version: REGISTRY_VERSION,
    sourceFile: "prompts/auditor.ts",
    expectedBehavior: [
      "prompt MUST mention 'verdicts'",
      "prompt MUST NOT contain '```json' (markdown fence)",
      "prompt MUST NOT contain '<tool_call' (XML drift)",
      "prompt MUST mention 'already met or wont-do'",
      "prompt MUST mention 'c1, c2'",
      "prompt MUST mention 'WORKER CAPABILITIES'",
      "prompt MUST mention 'allowlisted'",
      "prompt MUST mention 'build'",
      "prompt MUST mention 'command'",
      "prompt MUST mention 'Output ONLY valid JSON'",
    ],
    lastValidatedModel: "deepseek-v4-flash:cloud",
    lastValidatedAt: Date.UTC(2026, 6, 15),
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
      "prompt MUST mention 'Output ONLY valid JSON'",
      "prompt MUST mention 'description'",
      "prompt MUST mention 'expectedFiles'",
    ],
    lastValidatedModel: "glm-5.1:cloud",
    lastValidatedAt: Date.UTC(2026, 6, 15),
  },
  {
    name: "replanner-todos",
    version: REGISTRY_VERSION,
    sourceFile: "prompts/replanner.ts",
    expectedBehavior: [
      "prompt MUST NOT contain '```json' (markdown fence)",
      "prompt MUST NOT contain '<tool_call' (XML drift)",
      "prompt MUST mention 'Output ONLY valid JSON'",
      "prompt MUST mention 'revised'",
    ],
    lastValidatedModel: "glm-5.1:cloud",
    lastValidatedAt: Date.UTC(2026, 6, 15),
  },
  {
    name: "verifier-review",
    version: REGISTRY_VERSION,
    sourceFile: "prompts/verifier.ts",
    expectedBehavior: [
      "prompt MUST NOT contain '```json' (markdown fence)",
      "prompt MUST NOT contain '<tool_call' (XML drift)",
      "prompt MUST mention 'Output ONLY valid JSON'",
      "prompt MUST mention 'verified'",
      "prompt MUST mention 'evidenceCitation'",
    ],
    lastValidatedModel: "glm-5.1:cloud",
    lastValidatedAt: Date.UTC(2026, 6, 15),
  },
  {
    name: "critic-review",
    version: REGISTRY_VERSION,
    sourceFile: "prompts/critic.ts",
    expectedBehavior: [
      "prompt MUST NOT contain '```json' (markdown fence)",
      "prompt MUST NOT contain '<tool_call' (XML drift)",
      "prompt MUST mention 'Output ONLY valid JSON'",
      "prompt MUST mention 'accept'",
      "prompt MUST mention 'reject'",
    ],
    lastValidatedModel: "glm-5.1:cloud",
    lastValidatedAt: Date.UTC(2026, 6, 15),
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
    lastValidatedAt: Date.UTC(2026, 6, 15),
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
    lastValidatedAt: Date.UTC(2026, 6, 15),
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
    lastValidatedAt: Date.UTC(2026, 6, 15),
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
    lastValidatedAt: Date.UTC(2026, 6, 15),
  },
  {
    name: "shared-json-snippets",
    version: REGISTRY_VERSION,
    sourceFile: "prompts/sharedSnippets.ts",
    expectedBehavior: [
      "prompt MUST mention 'Output ONLY valid JSON'",
      "prompt MUST mention 'markdown fences'",
      "prompt MUST mention 'MENTION_CONTRACT_NOTE'",
      "prompt MUST mention 'JSON_ONLY_FINAL_RULE_LINES'",
      "prompt MUST mention 'JSON_ARRAY_ONLY_LINE'",
      "prompt MUST mention 'Return ONLY a JSON array'",
    ],
    lastValidatedModel: "n/a-static",
    lastValidatedAt: Date.UTC(2026, 6, 15),
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
    lastValidatedAt: Date.UTC(2026, 6, 15),
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
    lastValidatedAt: Date.UTC(2026, 6, 15),
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
    lastValidatedAt: Date.UTC(2026, 6, 15),
  },
  {
    name: "council-todo-extract",
    version: REGISTRY_VERSION,
    sourceFile: "councilDecisions.ts",
    expectedBehavior: [
      "prompt MUST mention 'JSON_ARRAY_ONLY_LINE'",
      "prompt MUST mention 'ACTIONABLE'",
      "prompt MUST mention 'PARTITIONING'",
      "prompt MUST mention 'buildAuditFollowUpTodoPrompt'",
      "prompt MUST mention 'buildCouncilTodoExtractPrompt'",
    ],
    lastValidatedModel: "deepseek-v4-flash:cloud",
    lastValidatedAt: Date.UTC(2026, 6, 15),
  },
];
