// Prompt registry — lightweight snapshots of every prompt with behavior
// assertions. When a model changes, run the eval catalog against the
// current assertions to detect drift BEFORE production runs stall.
//
// Each entry has a version hash (update manually when the prompt changes)
// so git blame shows what changed and when.
//
// Usage: npx tsx eval/run-eval.mjs --drift-check

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

export const promptRegistry: PromptSnapshot[] = [
  {
    name: "planner-todos",
    version: "2026-05-09",
    sourceFile: "prompts/planner.ts",
    expectedBehavior: [
      "prompt MUST mention 'description' as output field",
      "prompt MUST mention 'expectedFiles' as output field",
      "prompt MUST NOT contain '```json' (markdown fence — would cause format failure)",
      "prompt MUST NOT contain '<tool_call' (XML drift instruction — must remain prohibition)",
      "prompt MUST prohibit read-only TODOs (rule 5a: 'DO NOT emit read-only TODOs')",
      "prompt MUST require output is JSON array only (rule 1: 'Output ONLY a JSON array')",
    ],
    lastValidatedModel: "glm-5.1:cloud",
    lastValidatedAt: 0,
  },
  {
    name: "worker-hunks",
    version: "2026-05-09",
    sourceFile: "prompts/worker.ts",
    expectedBehavior: [
      "prompt MUST mention 'hunks' as output array",
      "prompt MUST mention 'skip' as optional output field",
      "prompt MUST NOT contain '```json' (markdown fence)",
      "prompt MUST NOT contain '<tool_call' (XML drift)",
      "prompt MUST require hunks use op field (replace|create|append)",
      "prompt MUST limit hunks to MAX_HUNKS (16)",
    ],
    lastValidatedModel: "gemma4:31b-cloud",
    lastValidatedAt: 0,
  },
  {
    name: "auditor-verdict",
    version: "2026-05-09",
    sourceFile: "prompts/auditor.ts",
    expectedBehavior: [
      "prompt MUST mention 'verdicts' as output array",
      "prompt MUST NOT contain '```json' (markdown fence)",
      "prompt MUST NOT contain '<tool_call' (XML drift)",
      "prompt MUST require verdicts exclude met/wont-do criteria (rule 3)",
      "prompt MUST require verdicts reference criterion IDs (c1, c2, ...)",
    ],
    lastValidatedModel: "deepseek-v4-flash:cloud",
    lastValidatedAt: 0,
  },
  {
    name: "contract-criteria",
    version: "2026-05-09",
    sourceFile: "prompts/firstPassContract.ts",
    expectedBehavior: [
      "prompt MUST mention 'contract' as output object",
      "prompt MUST mention 'dropped' as output array",
      "prompt MUST NOT contain '```json' (markdown fence)",
      "prompt MUST NOT contain '<tool_call' (XML drift)",
      "prompt MUST require criteria include 'description' field",
      "prompt MUST require criteria include 'expectedFiles' field",
    ],
    lastValidatedModel: "glm-5.1:cloud",
    lastValidatedAt: 0,
  },
  {
    name: "replanner-todos",
    version: "2026-05-09",
    sourceFile: "prompts/replanner.ts",
    expectedBehavior: [
      "prompt MUST NOT contain '```json' (markdown fence)",
      "prompt MUST NOT contain '<tool_call' (XML drift)",
      "prompt MUST require output is valid JSON format",
    ],
    lastValidatedModel: "glm-5.1:cloud",
    lastValidatedAt: 0,
  },
  {
    name: "verifier-review",
    version: "2026-05-09",
    sourceFile: "prompts/verifier.ts",
    expectedBehavior: [
      "prompt MUST NOT contain '```json' (markdown fence)",
      "prompt MUST NOT contain '<tool_call' (XML drift)",
    ],
    lastValidatedModel: "glm-5.1:cloud",
    lastValidatedAt: 0,
  },
  {
    name: "critic-review",
    version: "2026-05-09",
    sourceFile: "prompts/critic.ts",
    expectedBehavior: [
      "prompt MUST NOT contain '```json' (markdown fence)",
      "prompt MUST NOT contain '<tool_call' (XML drift)",
      "prompt MUST require output is valid JSON format",
    ],
    lastValidatedModel: "glm-5.1:cloud",
    lastValidatedAt: 0,
  },
];
