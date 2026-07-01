# Plan 8: Maximize Context Window — Leverage 1M Tokens for Better Performance

## Problem

The system uses only 1-3% of deepseek-v4-flash:cloud's 1M token context window.
Conservative character-based caps (designed for smaller models) limit what agents
can see, leading to:
- Workers declining because they can't see the full file
- Planners proposing TODOs for things that already exist
- Auditors missing context in the omitted middle of large files

With 1M tokens, agents could see the ENTIRE project context — full files, full
repo listing, full README, complete contract history, all prior work.

## Current Context Usage vs. Capacity

| Agent | Typical Usage | Max Capacity | Utilization |
|-------|--------------|--------------|-------------|
| Worker | ~5,000 tokens | 1,000,000 | **0.5%** |
| Planner | ~10,000 tokens | 1,000,000 | **1%** |
| Auditor | ~27,000 tokens | 1,000,000 | **2.7%** |
| Council | ~10,000 tokens | 1,000,000 | **1%** |

The primary constraint is NOT the context window — it's the character-based caps
designed for smaller models where timeouts and prompt costs were limiting factors.

## Approach: Tiered Context Scaling

Instead of removing all caps (which would be wasteful for small files), scale
context based on the model's known context window.

### 1. Model-Aware Context Budget

```typescript
// New: modelContextBudget.ts
interface ModelContextBudget {
  /** Maximum input tokens for this model */
  maxInputTokens: number;
  /** Fraction of context to use for file content (leave room for prompt + response) */
  fileContentFraction: number;
  /** Fraction for transcript/history */
  transcriptFraction: number;
  /** Whether to show full files or windowed */
  fullFileMode: boolean;
}

const MODEL_BUDGETS: Record<string, ModelContextBudget> = {
  // Large context models (1M+)
  "deepseek-v4-flash:cloud": {
    maxInputTokens: 1_000_000,
    fileContentFraction: 0.4,  // 400K tokens for files
    transcriptFraction: 0.2,   // 200K tokens for history
    fullFileMode: true,
  },
  "deepseek-v4-pro:cloud": {
    maxInputTokens: 1_000_000,
    fileContentFraction: 0.4,
    transcriptFraction: 0.2,
    fullFileMode: true,
  },
  // Medium context models (128K)
  "glm-5.1:cloud": {
    maxInputTokens: 128_000,
    fileContentFraction: 0.3,
    transcriptFraction: 0.15,
    fullFileMode: false,  // still window files
  },
  // Small context models (8K-32K)
  "gemma4:latest": {
    maxInputTokens: 8_192,
    fileContentFraction: 0.3,
    transcriptFraction: 0.1,
    fullFileMode: false,
  },
};
```

### 2. Expand Worker File Content

For large-context models, show full file content instead of windowed:

```typescript
// workerRunner.ts — replace windowFileForWorker with budget-aware version
const budget = getModelBudget(ctx.getActive()?.model);
if (budget.fullFileMode) {
  // Show full file content for large-context models
  contents = await ctx.readExpectedFiles(todo.expectedFiles);
  // No windowing — full content
} else {
  // Existing windowed behavior for smaller models
  contents = await ctx.readExpectedFiles(todo.expectedFiles);
  // Window via windowFileForWorker
}
```

**Impact:** Workers can see the ENTIRE file, not just head+tail. No more "section not visible" declines.

### 3. Expand Repo File List

For large-context models, include the full repo listing:

```typescript
// planner.ts — expand repo file list
const budget = getModelBudget(ctx.getActive()?.model);
const maxFiles = budget.fullFileMode ? 500 : 150;
const fileList = seed.repoFiles.slice(0, maxFiles).join("\n");
```

**Impact:** Planners see the full project structure. No more proposing TODOs for files that don't exist.

### 4. Expand README Excerpt

```typescript
// planner.ts — expand README
const budget = getModelBudget(ctx.getActive()?.model);
const readmeLimit = budget.fullFileMode ? 20_000 : 4_000;
const readme = seed.readmeExcerpt?.slice(0, readmeLimit) ?? "(no README)";
```

**Impact:** Planners understand the full project vision, not just the first 4KB.

### 5. Expand Auditor File State

```typescript
// auditor.ts — expand file state budget
const budget = getModelBudget(ctx.getActive()?.model);
const fileStateBudget = budget.fullFileMode ? 500_000 : 60_000;
// Use fileStateBudget instead of AUDITOR_FILE_STATE_MAX_CHARS
```

**Impact:** Auditors see full file contents for all criteria, not just head+tail.

### 6. Expand Council Context

```typescript
// councilPromptHelpers.ts — expand repo files and project context
const budget = getModelBudget(ctx.getActive()?.model);
const maxRepoFiles = budget.fullFileMode ? 500 : 80;
const maxDirs = budget.fullFileMode ? 200 : 30;
```

**Impact:** Council agents see the full project structure. Better analysis.

### 7. Transcript Full History

For large-context models, include more transcript history:

```typescript
// auditor.ts — expand transcript context
const budget = getModelBudget(ctx.getActive()?.model);
const maxItems = budget.fullFileMode ? 200 : 40;
// Use maxItems instead of MAX_CONTEXT_ITEMS
```

**Impact:** Auditors see more context about what happened, not just the last 40 items.

## Implementation

### New Files

1. `server/src/swarm/modelContextBudget.ts` — Model-aware context budget definitions

### Files to Modify

1. `server/src/swarm/blackboard/workerRunner.ts` — Use budget for file content
2. `server/src/swarm/blackboard/prompts/planner.ts` — Use budget for repo files, README
3. `server/src/swarm/blackboard/prompts/auditor.ts` — Use budget for file state, transcript
4. `server/src/swarm/blackboard/prompts/firstPassContract.ts` — Use budget for repo files, README
5. `server/src/swarm/blackboard/prompts/councilPromptHelpers.ts` — Use budget for repo files
6. `server/src/swarm/blackboard/windowFile.ts` — Add full-file mode option

## Expected Impact

| Change | Before | After (1M model) |
|--------|--------|-------------------|
| Worker file visibility | Head+tail (6KB) | Full file (up to 200KB) |
| Planner repo files | 60-150 paths | 500 paths |
| Planner README | 4KB | 20KB |
| Auditor file state | 60KB | 500KB |
| Council repo files | 80-100 paths | 500 paths |
| Transcript history | 40 items | 200 items |

## Risk Mitigation

1. **Latency** — Larger prompts take longer to process. Monitor p95 latency.
2. **Cost** — More tokens = higher cost. The `maxCostUsd` cap still applies.
3. **Quality** — More context doesn't always mean better output. Some models perform worse with very long contexts. Test empirically.
4. **Graceful degradation** — If a model can't handle the expanded context, fall back to windowed mode.

## Testing

1. Unit test: `getModelBudget` returns correct budget for each model
2. Integration test: Worker with full file mode produces valid hunks
3. Integration test: Planner with full repo listing doesn't timeout
4. Integration test: Auditor with expanded file state produces correct verdicts
5. Load test: Large prompts don't exceed model's actual context limit
