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

## Concept: Brain as Quality Overseer

The brain already fires on parse failures (`brain-fallback` events). Expand it to:

1. **Monitor exception events** — collect all `brain-fallback`, `worker_declined`,
   `stale_todo`, `replan_skip`, `empty_response`, `loop_detected` events
2. **Analyze patterns** — after each audit cycle (or on demand), summarize what
   went wrong and why
3. **Propose fixes** — generate concrete improvement proposals (prompt changes,
   rule additions, new patterns to detect)
4. **Record lessons** — write findings to `.swarm-memory.jsonl` so future runs
   benefit

## Architecture

```
                    ┌─────────────────┐
                    │  Brain Overseer  │
                    │  (new module)    │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────▼───────┐ ┌───▼────────┐ ┌──▼──────────────┐
     │ Exception       │ │ Pattern    │ │ Improvement     │
     │ Collector       │ │ Analyzer   │ │ Proposer        │
     │                 │ │            │ │                 │
     │ • brain-fallback│ │ • count    │ │ • prompt fixes  │
     │ • worker_decline│ │ • classify │ │ • rule additions│
     │ • stale_todo    │ │ • trend    │ │ • new detectors │
     │ • replan_skip   │ │            │ │                 │
     │ • empty_response│ │            │ │                 │
     │ • loop_detected │ │            │ │                 │
     └─────────────────┘ └────────────┘ └─────────────────┘
```

## Components

### 1. Exception Collector (`server/src/swarm/blackboard/brainOverseer/exceptionCollector.ts`)

Captures structured exception events from the existing event system:

```typescript
interface ExceptionEvent {
  type: "brain_fallback" | "worker_declined" | "stale_todo" | "replan_skip" 
      | "empty_response" | "loop_detected" | "degenerate_contract";
  agentId: string;
  todoId?: string;
  reason: string;
  timestamp: number;
  context?: Record<string, unknown>;
}

class ExceptionCollector {
  private events: ExceptionEvent[] = [];
  
  record(event: ExceptionEvent): void {
    this.events.push(event);
    // Also log to the run's transcript for visibility
  }
  
  getRecent(n: number = 50): ExceptionEvent[] { ... }
  getPatternSummary(): PatternSummary { ... }
  reset(): void { this.events = []; }
}
```

Wire into existing event emission points:
- `brainIntegration.ts` → already emits `brain-fallback` events
- `workerRunner.ts` → emit on decline/skip
- `replanManager.ts` → emit on skip
- `contractBuilder.ts` → emit on degenerate contract detection
- `plannerRunner.ts` → emit on empty response

### 2. Pattern Analyzer (`server/src/swarm/blackboard/brainOverseer/patternAnalyzer.ts`)

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
  // e.g., "3 todos declined because target section not in windowed view"
  // suggestedFix: "Add expectedAnchors to these todos or auto-detect anchors"
}
```

### 3. Improvement Proposer (`server/src/swarm/blackboard/brainOverseer/improvementProposer.ts`)

After each audit cycle (or when the run ends), the brain generates improvement proposals:

```typescript
async function proposeImprovements(
  collector: ExceptionCollector,
  promptFn: BrainPromptFn,
  agent?: Agent,
): Promise<ImprovementProposal[]> {
  const summary = collector.getPatternSummary();
  if (summary.totalExceptions === 0) return [];
  
  const prompt = buildImprovementPrompt(summary);
  const response = await promptFn(prompt, agent?.model ?? "gemma4:31b-cloud", 4096, 30000, agent);
  return parseImprovementResponse(response);
}

interface ImprovementProposal {
  category: "prompt" | "rule" | "detector" | "config";
  title: string;
  description: string;
  affectedComponent: string;  // e.g., "planner prompt", "worker runner"
  priority: "high" | "medium" | "low";
}
```

### 4. Integration Points

#### During the run (lightweight monitoring)

In `tierRunner.ts`'s audit cycle, after the auditor fires:

```typescript
// After runAuditor
const exceptions = ctx.getExceptionCollector().getRecent(10);
if (exceptions.length >= 3) {
  const summary = ctx.getExceptionCollector().getPatternSummary();
  ctx.appendSystem(`[brain-overseer] Detected ${exceptions.length} exceptions: ${summary.recurringPatterns.map(p => p.pattern).join("; ")}`);
}
```

#### Post-run (full analysis)

In `lifecycleRunner.ts` reflection passes, after memory distillation:

```typescript
// After runMemoryDistillationPass
if (brainEnabled()) {
  const proposals = await proposeImprovements(exceptionCollector, promptFn, agent);
  if (proposals.length > 0) {
    await writeImprovementProposals(clonePath, runId, proposals);
    // Also append to .swarm-memory.jsonl as lessons
  }
}
```

### 5. Output: Improvement Proposals File

Write to `logs/{runId}/improvements.json`:

```json
{
  "runId": "d32fd98e",
  "totalExceptions": 47,
  "patterns": [
    {
      "pattern": "Worker declined todo because target section not in windowed view",
      "count": 12,
      "suggestedFix": "Auto-detect anchors from todo description (Plan 3)"
    },
    {
      "pattern": "Replanner skipped todo because section appears missing in windowed view",
      "count": 8,
      "suggestedFix": "Apply auto-anchor to replanner path + strengthen skip prompt"
    },
    {
      "pattern": "Planner produced degenerate contract after compaction",
      "count": 3,
      "suggestedFix": "Filter degenerate contracts (already implemented)"
    }
  ],
  "proposals": [
    {
      "category": "rule",
      "title": "Auto-anchor for replanner",
      "description": "Apply extractSectionKeywords to replanner path when file is windowed",
      "affectedComponent": "replanManager.ts",
      "priority": "high"
    }
  ]
}
```

### 6. UI: Brain Insights Panel

Add a tab or section in the Analytics/History view showing:

- Exception count and types
- Recurring patterns
- Improvement proposals
- Status of proposals (implemented / pending)

This gives the user visibility into what the system learned.

## Files to Create

1. `server/src/swarm/blackboard/brainOverseer/exceptionCollector.ts` — Event collection
2. `server/src/swarm/blackboard/brainOverseer/patternAnalyzer.ts` — Pattern detection
3. `server/src/swarm/blackboard/brainOverseer/improvementProposer.ts` — Proposal generation
4. `server/src/swarm/blackboard/brainOverseer/prompt.ts` — Brain prompt for improvement proposals

## Files to Modify

1. `server/src/swarm/blackboard/workerRunner.ts` — Emit worker_declined events
2. `server/src/swarm/blackboard/replanManager.ts` — Emit replan_skip events
3. `server/src/swarm/blackboard/tierRunner.ts` — Wire in exception monitoring
4. `server/src/swarm/blackboard/lifecycleRunner.ts` — Post-run improvement proposal generation
5. `server/src/swarm/blackboard/summary.ts` — Include exception summary in run summary

## Implementation Priority

This is a **Phase 2** feature — implement Plans 1-3 first, then add the overseer
on top. The overseer is most valuable when there's a critical mass of exception
events to analyze (after the other fixes are in place).
