# Plan 4: Brain as System Overseer — Monitor Exception Cases, Agent-Auditor Interactions, and Improve Quality

## Problem

The swarm system has recurring failure patterns and a **broken feedback loop** for
skip/reject decisions:

1. **Agent-auditor interaction gaps** — When a worker skips a todo, the replanner
   decides revise/skip, and the auditor evaluates the result — nobody tracks the
   full chain. The information is scattered across the transcript (append-only log),
   the todo's final status, and the criterion's rationale.

2. **System failure patterns** — Windowed file declines, degenerate contracts, empty
   responses, redundant work, skip loops.

3. **No cross-run learning** — Each run starts fresh with no knowledge of what failed
   in prior runs.

Today these are handled by ad-hoc fixes. The brain could do better: **observe the
full agent-auditor interaction chain, detect patterns, and propose systemic improvements**.

## The Broken Feedback Loop

Here's what happens when a worker skips a todo:

```
Worker skips todo
  → failTodoQ(staleReason="declined") → wire status "stale"
  → enqueueReplan(todoId)
  → Replanner sees stale todo + current file state
  → Replanner decides: revise OR skip
  → If skip: skipTodoQ() → wire status "skipped"
  → Auditor sees skipped todos in its prompt
  → Auditor decides: met/wont-do/unmet for the CRITERION
```

**Nobody tracks the full chain.** The events are:
- ✅ Worker skip reason → recorded in todo
- ✅ Replanner decision → recorded in todo (skip) or new todo (revise)
- ✅ Auditor verdict → recorded on criterion
- ❌ **The full chain (skip→replanner→auditor→result)** — only in transcript
- ❌ **What happened AFTER the skip** — no structured tracking
- ❌ **Whether the skip was correct** — brain never sees this interaction

## Key Insight: Three Separate Concerns

1. **Project-level** (Auditor): "Is the work done? Are the criteria met?"
   - Evaluates contract criteria, file state, worker output
   - Runs every audit cycle

2. **System-level** (Brain Overseer): "Is the system itself working well?"
   - Monitors failure patterns across runs
   - Proposes prompt/rule/config improvements
   - Runs post-audit or on-demand

3. **Interaction-level** (Event Chain Tracker): "What happened when X did Y?"
   - Tracks agent→replanner→auditor chains
   - Records skip/revise/override outcomes
   - Feeds into both auditor context and brain analysis

These are three distinct responsibilities. The auditor shouldn't be polluted with
monitoring logic. The brain shouldn't be doing real-time tracking. A dedicated
event chain tracker captures structured interaction data that both the auditor
and brain can consume.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Run Lifecycle                          │
│                                                             │
│  Planner → Workers → Auditor (project-level)                │
│         ↕              ↕                                    │
│    Replanner ←── Event Chain Tracker (interaction-level)    │
│         ↕              ↕                                    │
│              Brain Overseer (system-level)                   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Event Chain Tracker

Records structured interaction events:

```typescript
interface InteractionEvent {
  type: "worker_skip" | "replanner_revise" | "replanner_skip" 
      | "auditor_override" | "auditor_accept" | "worker_retry_success"
      | "worker_retry_fail" | "criterion_resolved" | "criterion_stuck";
  todoId: string;
  criterionId?: string;
  agentId: string;
  reason: string;
  /** What the previous event in the chain was */
  chainParent?: string;  // event ID
  timestamp: number;
}
```

This creates **linked chains** of events:
```
worker_skip(t1, "section not found")
  → replanner_skip(t1, "file reorganized")
    → auditor_accept(c3, "wont-do: section removed")
```

Or:
```
worker_skip(t1, "section not found")
  → replanner_revise(t1, "add Demographics anchor")
    → worker_retry_success(t1, "row inserted")
      → auditor_accept(c3, "met: row present")
```

### Brain Overseer

Analyzes interaction chains to find systemic issues:

```typescript
interface ChainAnalysis {
  /** How many skip chains ended in auditor_accept vs auditor_override */
  skipOutcomeDistribution: { accepted: number; overridden: number };
  /** Which skip reasons are most common */
  topSkipReasons: Array<{ reason: string; count: number; outcome: string }>;
  /** Which criteria are perpetually stuck (never resolved) */
  stuckCriteria: Array<{ criterionId: string; skipCount: number; reason: string }>;
  /** Proposed fixes for recurring patterns */
  proposals: ImprovementProposal[];
}
```

## Components

### 1. Event Chain Tracker (`server/src/swarm/blackboard/brainOverseer/interactionTracker.ts`)

Captures structured interaction events and links them into chains:

```typescript
class InteractionTracker {
  private events: InteractionEvent[] = [];
  private chains: Map<string, InteractionEvent[]> = new Map();

  recordSkip(todoId: string, agentId: string, reason: string): string {
    const event = { type: "worker_skip", todoId, agentId, reason, ... };
    this.events.push(event);
    this.getChain(todoId).push(event);
    return event.id;
  }

  recordReplannerDecision(todoId: string, decision: "revise" | "skip", reason: string, parentId: string): string {
    const event = { type: decision === "skip" ? "replanner_skip" : "replanner_revise", ... };
    this.events.push(event);
    this.getChain(todoId).push(event);
    return event.id;
  }

  recordAuditorVerdict(criterionId: string, todoId: string, verdict: string, reason: string, parentId: string): string {
    const event = { type: verdict === "met" ? "auditor_accept" : "auditor_override", ... };
    this.events.push(event);
    return event.id;
  }

  getChain(todoId: string): InteractionEvent[] { ... }
  getChains(): InteractionEvent[][] { ... }
  getSummary(): ChainAnalysis { ... }
}
```

Wire into existing code paths:

| Code path | Event to record |
|-----------|----------------|
| `workerRunner.ts` line 635 (`failTodoQ` with "declined") | `worker_skip` |
| `replanManager.ts` line 198 (`parsed.action === "skip"`) | `replanner_skip` |
| `replanManager.ts` line 204 (after revise) | `replanner_revise` |
| `workerRunner.ts` line 599 (auditor override) | `auditor_override` |
| `workerRunner.ts` line 633 (auditor confirm) | `auditor_accept` |
| `auditorRunner.ts` line 347 (criterion met) | `criterion_resolved` |
| `auditorRunner.ts` line 351 (criterion wont-do) | `criterion_stuck` |

### 2. Brain Overseer (`server/src/swarm/blackboard/brainOverseer/brainOverseer.ts`)

Analyzes interaction chains and proposes improvements:

```typescript
async function analyzeSystem(
  tracker: InteractionTracker,
  collector: ExceptionCollector,
  promptFn: BrainPromptFn,
  agent?: Agent,
): Promise<SystemAnalysis> {
  const chains = tracker.getChains();
  const exceptions = collector.getPatternSummary();

  // Build analysis prompt with full context
  const prompt = buildAnalysisPrompt(chains, exceptions);

  // Use caller's agent for real model context
  const response = await promptFn(prompt, agent?.model ?? "gemma4:31b-cloud", 4096, 30000, agent);

  return parseAnalysisResponse(response);
}
```

### 3. Cross-Run Storage

```
.swarm-improvements/
  proposals.jsonl       ← append-only, accumulates across runs
  interaction-chains.jsonl  ← structured chain records
  implemented.jsonl     ← tracks which proposals were acted on
```

### 4. Brain Prompt with Full Context

The brain now receives:

```
=== INTERACTION CHAINS FROM THIS RUN ===

Chain 1: todo t1 "Add UNHCR row to Demographics"
  - worker_skip: "section not in windowed view"
  - replanner_skip: "file reorganized, section moved"
  - auditor_accept(c3, "wont-do: section removed")

Chain 2: todo t5 "Add ILO panel"
  - worker_skip: "panel already exists in registry"
  - replanner_revise: "Register existing panel in App.jsx"
  - worker_retry_success: "panel registered"
  - auditor_accept(c2, "met: panel registered")

Chain 3: todo t9 "Create ErrorFallback component"
  - worker_skip: "Cannot see inline ErrorBoundary in windowed view"
  - replanner_revise: "Extract inline ErrorBoundary to separate file"
  - worker_retry_fail: "empty response"
  - auditor_accept(c7, "unmet: component not created")

=== EXCEPTION PATTERNS ===
- 12 worker declines due to windowed file view
- 8 replanner skips due to file reorganization
- 3 empty responses from worker

=== PRIOR RUN IMPROVEMENTS (from .swarm-improvements/) ===
- Auto-anchor for large files (implemented)
- Degenerate contract filter (implemented)

=== YOUR TASK ===
Analyze these interaction chains and exception patterns. Produce:
1. Root causes for recurring skip chains
2. Which auditor accept/override decisions were correct vs questionable
3. Proposed improvements to prevent these patterns
4. Priority ranking of improvements
```

### 5. Integration Points

#### During run: lightweight chain tracking

In `workerRunner.ts`, `replanManager.ts`, `auditorRunner.ts` — emit interaction
events as they happen. The tracker accumulates them in memory.

#### Post-run: full analysis

In `lifecycleRunner.ts` reflection passes:

```typescript
if (brainEnabled()) {
  const analysis = await analyzeSystem(interactionTracker, exceptionCollector, promptFn, agent);
  await appendProposals(clonePath, runId, analysis.proposals);
  await appendInteractionChains(clonePath, runId, interactionTracker.getChains());
}
```

#### Next run: seed context

```typescript
// In plannerRunner.ts
const priorImprovements = await readPendingProposals(clonePath);
const priorChains = await readRecentChains(clonePath, 20);  // last 20 chains
if (priorImprovements.length > 0 || priorChains.length > 0) {
  seed.systemContext = buildSystemContextBlock(priorImprovements, priorChains);
}
```

Render in planner prompt:
```
=== SYSTEM CONTEXT (from prior runs) ===
Improvement proposals:
- Auto-anchor for replanner: When section not visible in windowed view, grep for it before skipping
- Worker context files: Add contextFiles to todos for related file reference

Recent interaction patterns:
- Chain: worker_skip → replanner_skip → auditor_accept (reason: file reorganized)
- Chain: worker_skip → replanner_revise → worker_retry_success → auditor_accept (reason: section found via anchor)
=== end SYSTEM CONTEXT ===
```

### 6. Auditor Context Enhancement

The auditor can also benefit from interaction chains. When evaluating a criterion
that has associated skip/revise history, the auditor should see the chain:

```typescript
// In auditor seed builder, add interaction chain context
if (interactionChains.length > 0) {
  // Include chains for todos linked to the current criterion
  seed.interactionHistory = interactionChains
    .filter(chain => chain.some(e => e.criterionId === criterion.id))
    .map(formatChainForAuditor);
}
```

This gives the auditor visibility into "this criterion was skipped 3 times before
being resolved" — helping it make better met/wont-do decisions.

## Files to Create

1. `server/src/swarm/blackboard/brainOverseer/interactionTracker.ts`
2. `server/src/swarm/blackboard/brainOverseer/brainOverseer.ts` (updated from Plan 4 v1)
3. `server/src/swarm/blackboard/brainOverseer/exceptionCollector.ts`
4. `server/src/swarm/blackboard/brainOverseer/patternAnalyzer.ts`
5. `server/src/swarm/blackboard/brainOverseer/prompt.ts`

## Files to Modify

1. `server/src/swarm/blackboard/workerRunner.ts` — Emit interaction events on skip/override
2. `server/src/swarm/blackboard/replanManager.ts` — Emit interaction events on revise/skip
3. `server/src/swarm/blackboard/auditorRunner.ts` — Emit interaction events on verdicts
4. `server/src/swarm/blackboard/tierRunner.ts` — Wire in chain tracking + post-run analysis
5. `server/src/swarm/blackboard/lifecycleRunner.ts` — Post-run brain analysis
6. `server/src/swarm/blackboard/plannerRunner.ts` — Read prior chains in seed
7. `server/src/swarm/blackboard/prompts/auditor.ts` — Include interaction history in auditor context
8. `server/src/swarm/blackboard/summary.ts` — Include chain analysis in run summary

## Implementation Priority

**Phase 1** (do first):
- Plan 1: Streaming transcript persistence
- Plan 2: Worker context files
- Plan 3: Auto-anchor for large files

**Phase 2** (after Phase 1 stabilizes):
- Plan 4: Brain system overseer (this plan, updated)
- Plan 5: Dedicated Planning tab

Phase 2 depends on Phase 1 because:
- The brain needs the streaming transcript data (Plan 1) for full context
- The interaction tracker needs the worker context files (Plan 2) to understand skip reasons
- The auto-anchor fix (Plan 3) reduces the noise in interaction chains
