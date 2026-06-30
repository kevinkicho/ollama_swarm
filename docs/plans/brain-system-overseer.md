# Plan 4: Brain as System Overseer — Monitor Exception Cases and Improve Quality

## Problem

The swarm system has recurring failure patterns that the AI models keep repeating:

- **Windowed file declines** — workers/replanner can't see middle sections of large files
- **Degenerate contracts** — planner produces "read the repo files" after compaction
- **Empty responses** — model emits XML tool-call syntax that gets stripped
- **Redundant work** — planner proposes TODOs for things that already exist
- **Skip loops** — replanner skips a todo, worker re-creates a similar one, cycle repeats

Today these are handled by ad-hoc fixes (auto-anchor, degenerate filter, retry limits).
The brain could do better: **monitor these patterns in real-time, record them, and
propose systemic improvements**.

## Key Insight: Auditor vs Brain Overseer

**Auditor** = project-level concerns. "Is the work done? Are the criteria met?"
Evaluates contract criteria, file state, worker output. Runs every audit cycle.

**Brain Overseer** = system-level concerns. "Is the system itself working well?
What failure patterns keep recurring? What should we fix in the next version?"
Monitors exception events across runs. Runs post-audit or on-demand.

These are fundamentally different responsibilities. The auditor shouldn't be
polluted with system-monitoring logic. A dedicated agent (virtual — same brain
prompt function infrastructure) handles system-level concerns.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Run Lifecycle                          │
│                                                             │
│  Planner → Workers → Auditor (project-level)                │
│                          │                                  │
│                          ▼                                  │
│              Exception events emitted                       │
│                          │                                  │
│              ┌───────────▼───────────┐                      │
│              │  Brain Overseer        │                      │
│              │  (system-level)        │                      │
│              │                        │                      │
│              │  1. Collect exceptions │                      │
│              │  2. Analyze patterns   │                      │
│              │  3. Propose fixes      │                      │
│              │  4. Record findings    │                      │
│              └───────────┬───────────┘                      │
│                          │                                  │
│                          ▼                                  │
│              .swarm-improvements/                            │
│                proposals.jsonl  (cross-run)                  │
│                implemented.jsonl                             │
│                                                             │
└─────────────────────────────────────────────────────────────┘

Next run reads .swarm-improvements/ in planner seed → avoids repeating
the same mistakes.
```

## Components

### 1. Exception Collector

Captures structured exception events from the existing event system:

```typescript
interface ExceptionEvent {
  type: "brain_fallback" | "worker_declined" | "stale_todo" | "replan_skip"
      | "empty_response" | "loop_detected" | "degenerate_contract"
      | "auditor_override" | "retry_exhausted";
  agentId: string;
  todoId?: string;
  reason: string;
  timestamp: number;
  /** Run ID — for cross-run deduplication */
  runId: string;
  context?: Record<string, unknown>;
}
```

Wire into existing event emission points:
- `brainIntegration.ts` → brain-fallback events
- `workerRunner.ts` → worker_declined events
- `replanManager.ts` → replan_skip events
- `contractBuilder.ts` → degenerate_contract events
- `plannerRunner.ts` → empty_response events
- `tierRunner.ts` → loop_detected events
- `auditorRunner.ts` → auditor_override events

### 2. Pattern Analyzer

Analyzes collected exceptions for recurring patterns:

```typescript
interface PatternSummary {
  totalExceptions: number;
  byType: Record<string, number>;
  recurringPatterns: Array<{
    pattern: string;
    count: number;
    affectedTodos: string[];
    suggestedFix: string;
  }>;
}
```

### 3. Improvement Proposer

After each audit cycle (or when the run ends), generates improvement proposals:

```typescript
interface ImprovementProposal {
  category: "prompt" | "rule" | "detector" | "config";
  title: string;
  description: string;
  affectedComponent: string;
  priority: "high" | "medium" | "low";
}
```

### 4. Cross-Run Storage

Improvements persist at clone root, NOT per-run:

```
.swarm-improvements/
  proposals.jsonl       ← append-only, accumulates across runs
  implemented.jsonl     ← tracks which proposals were acted on
```

Format of `proposals.jsonl`:
```json
{"ts":1782836506,"runId":"d32fd98e","type":"pattern","pattern":"Worker declined because target section not in windowed view","count":12,"suggestedFix":"Auto-detect anchors from todo description","priority":"high","status":"pending"}
```

### 5. Integration Into Run Lifecycle

#### During run: lightweight monitoring

In `tierRunner.ts` after each audit cycle, log a summary of recent exceptions.
No heavy analysis — just visibility.

```typescript
// After runAuditor — lightweight check
const recent = exceptionCollector.getRecent(10);
if (recent.length >= 3) {
  ctx.appendSystem(`[brain-overseer] ${recent.length} exceptions this cycle: ${summarize(recent)}`);
}
```

#### Post-run: full analysis + proposals

In `lifecycleRunner.ts` reflection passes, after memory distillation:

```typescript
if (brainEnabled()) {
  const proposals = await proposeImprovements(exceptionCollector, promptFn, agent);
  await appendProposals(clonePath, runId, proposals);
}
```

#### Next run: seed context

In `plannerRunner.ts` or `contractBuilder.ts`, read `.swarm-improvements/proposals.jsonl`
and include pending proposals in the planner seed:

```typescript
const proposals = await readPendingProposals(clonePath);
if (proposals.length > 0) {
  seed.systemImprovements = proposals.map(p => `${p.title}: ${p.suggestedFix}`);
}
```

Render in planner prompt:
```
=== SYSTEM IMPROVEMENTS (from prior runs — avoid these failure patterns) ===
- Auto-anchor for replanner: When section not visible in windowed view, grep for it before skipping
- Degenerate contract filter: Don't propose "read the repo" as a criterion
=== end SYSTEM IMPROVATIONS ===
```

### 6. Output

#### `proposals.jsonl` (cross-run)

```json
{"ts":1782836506,"runId":"d32fd98e","type":"pattern","pattern":"Worker declined because section not in windowed view","count":12,"suggestedFix":"Auto-detect anchors from todo description","priority":"high","status":"pending"}
```

#### Run summary addition

Include exception summary in `summary.json`:
```json
{
  "exceptions": {
    "total": 47,
    "byType": {"worker_declined": 12, "replan_skip": 8, "empty_response": 5},
    "patternsFound": 3,
    "proposalsGenerated": 2
  }
}
```

### 7. Brain Prompt for Proposals

```
You are the SYSTEM OVERSEER for a coding-agent swarm. Your job is to analyze
failure patterns and propose improvements to the system itself — not to the
project code.

You will receive a summary of exception events from the current run:
- Types of failures (worker declined, replan skip, empty response, etc.)
- Which todos were affected
- Suggested fixes from pattern analysis

Your task: produce a JSON array of improvement proposals. Each proposal:
- category: "prompt" (change a prompt), "rule" (add a hard rule), "detector" (new pattern detection), or "config" (change a setting)
- title: one-line description
- description: what to change and why
- affectedComponent: which file/module to modify
- priority: "high", "medium", or "low"

Do NOT propose changes to the project code — only to the swarm system itself.
Focus on changes that would prevent the patterns you see repeating.

Output ONLY a JSON array. No prose, no markdown fences.
```

## Files to Create

1. `server/src/swarm/blackboard/brainOverseer/exceptionCollector.ts`
2. `server/src/swarm/blackboard/brainOverseer/patternAnalyzer.ts`
3. `server/src/swarm/blackboard/brainOverseer/improvementProposer.ts`
4. `server/src/swarm/blackboard/brainOverseer/prompt.ts`

## Files to Modify

1. `server/src/swarm/blackboard/workerRunner.ts` — Emit worker_declined events
2. `server/src/swarm/blackboard/replanManager.ts` — Emit replan_skip events
3. `server/src/swarm/blackboard/tierRunner.ts` — Wire in exception monitoring + post-run proposals
4. `server/src/swarm/blackboard/lifecycleRunner.ts` — Call improvement proposer in reflection passes
5. `server/src/swarm/blackboard/plannerRunner.ts` — Read proposals.jsonl into planner seed
6. `server/src/swarm/blackboard/summary.ts` — Include exception summary

## Implementation Priority

**Phase 1** (do first):
- Plan 1: Streaming transcript persistence
- Plan 2: Worker context files
- Plan 3: Auto-anchor for large files

**Phase 2** (after Phase 1 stabilizes):
- Plan 4: Brain system overseer (this plan)

Phase 2 is most valuable when there's a critical mass of exception events to analyze — after Plans 1-3 are in place and the system is generating richer exception data.
