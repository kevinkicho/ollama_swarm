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

---

## Part 2: Self-Upgrade Workflow — Brain Applies Its Own Patches

### The Problem

The brain can analyze and propose improvements, but it can't modify its own code.
The proposals sit in `.swarm-improvements/proposals.jsonl` waiting for manual application.
This defeats the purpose of having an AI-powered system overseer.

### The Workflow

```
┌─────────────────────────────────────────────────────────────┐
│                    RUN LIFECYCLE                             │
│                                                             │
│  1. Run executes (workers, auditor, replanner)              │
│     └─ Brain monitors interactions in background            │
│                                                             │
│  2. Run completes → user sees "Run finished"                 │
│     └─ Brain enters ANALYSIS PHASE                          │
│     └─ UI shows: "Brain analyzing patterns..."              │
│     └─ Server stays alive — user CANNOT shutdown             │
│                                                             │
│  3. Brain produces patch-ready proposals                     │
│     └─ UI shows: "Brain preparing patch (3/5 changes)..."   │
│     └─ Each proposal has concrete hunks (search/replace)     │
│     └─ Brain verifies patches against codebase               │
│                                                             │
│  4. Patch ready → UI shows diff preview                      │
│     └─ User reviews and clicks "Apply" (or "Reject")        │
│     └─ OR: auto-apply if confidence is high                  │
│                                                             │
│  5. Apply phase → server enters UPGRADE MODE                 │
│     └─ UI switches to terminal-style display                 │
│     └─ Non-essential parts shut down (workers, auditor)      │
│     └─ AI connection stays alive (for brain verification)    │
│     └─ Patches applied one by one                            │
│     └─ Each patch verified before next                       │
│                                                             │
│  6. Patch applied → server restarts with new code            │
│     └─ UI shows: "System upgraded — restarting..."           │
│     └─ New code takes effect                                 │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Phase 1: Brain Analysis (post-run, takes time)

After the run completes, the brain enters analysis mode. This is NOT instant —
it needs to analyze interaction chains, exception patterns, and prior improvements.

**User experience:**
- Run summary appears (normal)
- Below the summary: "🧠 Brain analyzing this run's patterns..."
- Progress indicator: "Analyzing 47 exceptions across 12 interaction chains..."
- No "Stop" button available — server is in analysis mode
- User can navigate other tabs (History, etc.) but cannot start a new run

**Duration:** 30s–5min depending on exception count. Brain is doing real work
(pattern analysis, proposal generation, patch construction).

### Phase 2: Patch Generation

After analysis, the brain generates concrete code changes (hunks) for each proposal.

**User experience:**
- "🧠 Brain preparing patch (2/5 changes)..."
- Each change shows: title, affected file, confidence score
- Brain reads the target file, constructs search/replace hunks
- Brain validates hunks against the current codebase state

**Durability:** The brain must be thorough here. It reads the full file content,
verifies the search anchor exists, checks for conflicts with recent changes.
A bad patch is worse than no patch.

### Phase 3: Patch Preview

Brain presents the patch for human review.

**User experience:**
```
┌─────────────────────────────────────────────────────┐
│  🧠 Brain proposes 4 improvements                    │
│                                                     │
│  ✓ 1. Auto-anchor for replanner (high)              │
│     File: server/src/swarm/blackboard/replanManager.ts│
│     Change: Add extractSectionKeywords import +      │
│             auto-detect anchors before windowing     │
│     [Preview] [Reject]                               │
│                                                     │
│  ✓ 2. Strengthen replanner skip prompt (medium)      │
│     File: server/src/swarm/blackboard/prompts/replanner.ts│
│     Change: Add rule about preferring revise over    │
│             skip when section is renamed/moved       │
│     [Preview] [Reject]                               │
│                                                     │
│  ✓ 3. Add interaction chain tracking (high)          │
│     File: server/src/swarm/blackboard/brainOverseer/interactionTracker.ts│
│     Change: New module (120 lines)                   │
│     [Preview] [Reject]                               │
│                                                     │
│  ✓ 4. Wire interaction events into worker/replanner (medium)│
│     File: server/src/swarm/blackboard/workerRunner.ts│
│     Change: Emit worker_skip events on decline       │
│     [Preview] [Reject]                               │
│                                                     │
│  [Apply All] [Apply Selected] [Reject All]           │
└─────────────────────────────────────────────────────┘
```

### Phase 4: Upgrade Mode

When the user clicks "Apply" (or auto-apply fires), the server enters upgrade mode.

**Server behavior:**
1. Set `lifecycleState = "upgrading"`
2. Stop the cap watchdog, replan watcher, queue reaper
3. Kill any remaining worker processes
4. Keep the WebSocket alive (for UI updates)
5. Keep the AI connection alive (for brain verification)
6. Apply patches one by one via `applyAndCommit`

**UI behavior — terminal-style display:**
```
┌─────────────────────────────────────────────────────┐
│  🔧 SYSTEM UPGRADE                                   │
│                                                     │
│  Applying patch 1/4: Auto-anchor for replanner       │
│  > Reading server/src/swarm/blackboard/replanManager.ts│
│  > Applying search/replace (3 hunks)                 │
│  > Verifying: import added ✓, function body ✓        │
│  > Git commit: "brain: add auto-anchor for replanner"│
│                                                     │
│  Applying patch 2/4: Strengthen replanner prompt     │
│  > Reading server/src/swarm/blackboard/prompts/replanner.ts│
│  > Applying search/replace (1 hunk)                  │
│  > Verifying: rule text matches ✓                    │
│  > Git commit: "brain: strengthen replanner skip prompt"│
│                                                     │
│  Applying patch 3/4: Add interaction tracker         │
│  > Creating server/src/swarm/blackboard/brainOverseer/interactionTracker.ts│
│  > Writing 120 lines                                 │
│  > Verifying: exports match ✓                        │
│  > Git commit: "brain: add interaction chain tracker"│
│                                                     │
│  Applying patch 4/4: Wire events into worker/replanner│
│  > Reading server/src/swarm/blackboard/workerRunner.ts│
│  > Applying search/replace (2 hunks)                 │
│  > Verifying: emit calls added ✓                     │
│  > Git commit: "brain: wire interaction events"      │
│                                                     │
│  ✅ All patches applied (4/4 successful)              │
│  🔄 Restarting server with new code...               │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### Server Restart After Patches

After all patches are applied:

1. Write a marker file: `.swarm-upgrade-completed` with patch metadata
2. Exit the process (graceful shutdown)
3. The process manager (systemd, pm2, or manual) restarts the server
4. On startup, server reads `.swarm-upgrade-completed`:
   - Logs: "Brain applied 4 patches during last upgrade"
   - Clears the marker
   - Loads new code (already in place from step 1)

**Alternative:** If no process manager, the UI shows "Upgrade complete. Please
restart the server manually." with a restart button that calls `/api/swarm/restart`.

### New Components

#### `server/src/swarm/blackboard/brainOverseer/selfUpgrader.ts`

Manages the upgrade lifecycle:
```typescript
class SelfUpgrader {
  private state: "idle" | "analyzing" | "generating" | "preview" | "applying" | "restarting";
  
  async startAnalysis(runId: string): Promise<void> { ... }
  async generatePatches(): Promise<ImprovementProposal[]> { ... }
  async applyPatch(proposal: ImprovementProposal): Promise<PatchResult> { ... }
  async restart(): Promise<void> { ... }
  
  // UI state stream
  getState(): UpgradeState { ... }
}
```

#### `web/src/components/UpgradeMode.tsx`

Terminal-style UI for the upgrade phase:
```tsx
function UpgradeMode({ state }: { state: UpgradeState }) {
  return (
    <div className="bg-black text-green-400 font-mono p-4 rounded border border-green-800">
      <div className="text-green-300 mb-2">🔧 SYSTEM UPGRADE</div>
      {state.steps.map((step, i) => (
        <UpgradeStep key={i} step={step} />
      ))}
      {state.status === "restarting" && (
        <div className="animate-pulse">🔄 Restarting...</div>
      )}
    </div>
  );
}
```

### Server State During Upgrade

```typescript
// In lifecycleRunner.ts or a new upgradeManager.ts
async function enterUpgradeMode(ctx: UpgradeContext): Promise<void> {
  // 1. Stop all run activity
  ctx.setLifecycleState("upgrading");
  ctx.stopCapWatchdog();
  ctx.stopReplanWatcher();
  ctx.stopQueueReaper();
  
  // 2. Kill remaining workers
  for (const agent of ctx.getWorkers()) {
    ctx.manager.killAgent(agent.id);
  }
  
  // 3. Keep WebSocket alive for UI updates
  // 4. Keep AI connection alive for brain verification
  
  // 5. Apply patches
  for (const proposal of approvedProposals) {
    if (proposal.patch) {
      await applyHunks(proposal.patch.file, proposal.patch.hunks);
      await gitCommit(`brain: ${proposal.title}`);
      // Emit progress to UI via WebSocket
      ctx.emit({ type: "upgrade_progress", step: i, total: n, detail: "..." });
    }
  }
  
  // 6. Restart
  ctx.emit({ type: "upgrade_complete", patches: approvedProposals.length });
  process.exit(0); // Let process manager restart
}
```

### Files to Create

1. `server/src/swarm/blackboard/brainOverseer/selfUpgrader.ts` — Upgrade lifecycle
2. `web/src/components/UpgradeMode.tsx` — Terminal-style upgrade UI
3. `web/src/components/UpgradePreview.tsx` — Patch preview with diff display

### Files to Modify

1. `server/src/swarm/blackboard/lifecycleRunner.ts` — Enter upgrade mode after run completes
2. `server/src/swarm/blackboard/BlackboardRunner.ts` — Expose upgrade state
3. `web/src/components/SwarmView.tsx` — Render upgrade mode when active
4. `web/src/state/store.ts` — Add upgrade state to store

### Safety Measures

1. **Confidence threshold** — Brain must score each patch above 0.8 confidence
   before it's eligible for auto-apply. Below 0.8 → manual review required.
2. **Rollback on failure** — If any patch fails verification after application,
   revert all patches via `git reset --hard HEAD~N` and show error to user.
3. **Dry-run mode** — Patches can be previewed without application. Show the
   diff, verify search anchors exist, check for conflicts.
4. **Backup before upgrade** — Create a git tag `pre-brain-upgrade-{timestamp}`
   before applying patches, so rollback is trivial.
5. **User confirmation** — Unless `autoApplyBrainPatches: true` is set in config,
   always show the preview before applying.
