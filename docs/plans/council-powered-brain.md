# Plan 7: Council-Powered Brain — Multi-Agent Proposal Review

## Problem

The brain needs to analyze interaction chains and generate patch proposals, but a
single brain agent lacks the cross-examination capability that catches bad proposals.
The council preset provides independent analysis + cross-examination + synthesis —
exactly what's needed for proposal review. However, the council has critical bugs
that must be fixed first.

## Part 1: Fix Council Critical Bugs

Before adapting the council for the brain role, these bugs must be resolved:

### Bug 1: `synthesizeStandup` discards output (CRITICAL)

**File:** `CouncilRunner.ts` lines 527-561

The standup synthesis produces a JSON todo array but never parses or posts it.
The only source of work items for cycles 2+ is the audit phase. If the auditor
produces no new todos, the council stops — even though the standup produced valid
todos that were silently thrown away.

**Fix:** Parse the standup synthesis output and post todos to the queue:

```typescript
// After line 549 (inside the try block):
if (text) {
  const todos = parseJsonArrayFromResponse(text, normalizeCouncilTodo);
  for (const todo of todos) {
    this.state.todoQueue.post(todo);
  }
  this.appendSystem(`[Standup] Synthesized ${todos.length} proposals into unified plan.`);
}
```

### Bug 2: Dead code `tryBrainFallbackWorker` (CLEANUP)

**File:** `councilWorkerRunner.ts` lines 231-278

References undefined symbols (`tryBrainFallback`, `WorkerResponseSchema`). Never called.

**Fix:** Delete the dead function.

### Bug 3: Unreachable `unmetCount === 0` check (CLEANUP)

**File:** `CouncilRunner.ts` lines 456-463

The `unmetCount === 0` check inside `newTodos.length === 0` is unreachable because
the code at line 418 would have already returned.

**Fix:** Remove the dead code block.

### Bug 4: JSON parse errors silently swallowed (HIGH)

**File:** `CouncilRunner.ts` lines 484, 550

Blanket `catch { /* ignore */ }` hides both network errors AND parse errors.

**Fix:** Log the error before ignoring:
```typescript
} catch (err) {
  this.appendSystem(`[council] Standup synthesis failed: ${err instanceof Error ? err.message : String(err)}`);
}
```

### Bug 5: Leaked AbortController in `synthesizeStandup` (HIGH)

**File:** `CouncilRunner.ts` line 554

The AbortController is created inline and never stored. No cancellation path.

**Fix:** Store the controller and wire it to the run's stopping signal:
```typescript
const ac = new AbortController();
this.abortControllers.push(ac);  // Or use the existing abort mechanism
// ... later: ac.abort() on stop
```

### Bug 6: Greedy `[...]` extraction in `parseJsonArrayFromResponse` (MEDIUM)

**File:** ` councilUtils.ts` lines 45-48

Takes first `[` and last `]`, which can merge separate JSON arrays.

**Fix:** Use `extractJsonFromText` from `extractJson.ts` (already used elsewhere) instead of the greedy approach.

## Part 2: Council as Brain Proposal Reviewer

### Architecture

```
Brain Overseer triggers council run:
  │
  ▼
Council (3 agents) against swarm codebase:
  │
  ├─ Round 1 (peer-hidden): Each agent independently analyzes
  │  interaction chains, exception patterns, prior improvements
  │
  ├─ Round 2 (cross-examine): Agents review each other's proposals
  │  "Is auto-anchor the right fix, or should we fix the planner prompt?"
  │
  ├─ Round 3 (refine): Agents revise based on critique
  │
  ├─ Synthesis: Lead agent merges proposals into unified patch plan
  │
  └─ Vote: 2-vs-1 majority on contentious proposals
  │
  ▼
Best proposals selected → patch generation → apply
```

### How It Works

The brain triggers a council run against the swarm's own codebase:

```typescript
// In brainOverseer.ts, after pattern analysis:
const councilCfg: RunConfig = {
  repoUrl: swarmCodebasePath,
  localPath: swarmCodebasePath,
  agentCount: 3,
  rounds: 3,
  model: brainModel,
  preset: "council",
  councilReconcile: "vote",  // 2-vs-1 majority
  userDirective: buildBrainDirective(interactionChains, exceptionPatterns),
  wallClockCapMs: 30 * 60 * 1000,  // 30 min cap
};
await orchestrator.start(councilCfg);
```

### The Brain Directive for Council

```
You are analyzing the swarm system to propose improvements. You have access to:

1. Interaction chains from the last run (in .swarm-improvements/interaction-chains.jsonl)
2. Exception patterns (in .swarm-improvements/pattern-cache.json)
3. Prior improvements (in .swarm-improvements/proposals.jsonl)
4. The swarm's source code (this repo)

Your job: propose concrete patches to improve the swarm system.

For each improvement:
- Identify the root cause (not just symptoms)
- Propose a specific code change (search/replace hunks)
- Target a real file in this repo
- Explain why this fix prevents the pattern from recurring

Do NOT propose changes to the project code the swarm works on — only to the
swarm system itself. Focus on: prompt improvements, rule additions, new detectors,
config changes, and architecture fixes.

Output: JSON array of proposals with hunks.
```

### Why Council > Single Brain for This

1. **Independent analysis** — Round 1 is peer-hidden. Each agent analyzes the interaction chains without seeing others' proposals. This prevents groupthink and ensures diverse proposals.

2. **Cross-examination** — Round 2 reveals all proposals. Agents must verify: "Is this the right approach? Are the search anchors valid? Does this fix actually prevent the pattern?"

3. **Majority vote** — With `councilReconcile: "vote"`, each agent votes for the best OTHER agent's proposal. 2-vs-1 majority ensures the best proposal wins.

4. **Dissent preservation** — If one agent disagrees with the majority, its reasoning is preserved in the deliverable. The developer can see why.

5. **The council already has the infrastructure** — parallel workers, synthesis, audit, convergence detection. No new coordination layer needed.

### What Needs Modification

The council prompts assume code review ("auditing the codebase"). For the brain role, the prompts need adjustment:

**`councilPromptHelpers.ts`** — Add a conditional prompt block for brain mode:
```typescript
if (isBrainMode) {
  parts.push(
    "You are analyzing the SWARM SYSTEM to propose improvements.",
    "Read the interaction chains and exception patterns.",
    "Propose concrete patches to prevent recurring failures.",
    "Every patch must target a real file in this repo.",
  );
} else {
  // existing code review prompts
}
```

**`CouncilRunner.ts`** — Accept a `brainMode` flag in RunConfig that switches prompt behavior.

### Files to Modify for Council Fixes

1. `CouncilRunner.ts` — Fix synthesizeStandup (Bug 1), unreachable code (Bug 3), leaked AbortController (Bug 5)
2. `councilWorkerRunner.ts` — Delete dead `tryBrainFallbackWorker` (Bug 2)
3. `councilUtils.ts` — Fix greedy JSON extraction (Bug 6)
4. `councilPromptHelpers.ts` — Add brain mode prompts, fix hardcoded React paths (Bug 11)

### Files to Create for Brain Integration

1. `server/src/swarm/blackboard/brainOverseer/councilBrainAdapter.ts` — Adapts council for brain role
2. `server/src/swarm/blackboard/brainOverseer/proposalReviewer.ts` — Orchestrates council run for proposal review

## Implementation Priority

**Phase 1** (do first):
- Plan 1: Streaming transcript persistence
- Plan 2: Worker context files
- Plan 3: Auto-anchor for large files

**Phase 2** (after Phase 1 stabilizes):
- Plan 4: Brain system overseer (interaction tracking + exception collection)
- Plan 5: Dedicated Planning tab
- Plan 6: Brain optimization (caching, incremental patches)
- **Plan 7: Council-powered brain (this plan)**

Phase 7 depends on:
- Plan 4 (brain needs interaction chains and exception data)
- Council bug fixes (must be stable before adapting for brain role)
- Plan 6 (brain needs cached patterns to feed into council analysis)
