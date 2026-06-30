# Plan 9: Planner Thinking Visibility — Always Show in Transcript

## Problem

The planner (agent-1) was "thinking" for 11 minutes but no server-side streaming
data was visible. The `PlannerThinkingPanel` on the Board tab disappeared because:

1. **Phase mismatch**: The panel checks `phase !== "planning"` — but replanner calls
   run during `phase === "executing"`, so the panel hides itself.

2. **Empty streaming buffer**: During cold start (60-180s for cloud models) or
   tool-call phases, no streaming chunks arrive. The panel requires either
   `hasStream` (non-empty buffer) or `isThinking` (status === "thinking").

3. **The replanner uses the same agent** (index 1) but the panel's visibility
   logic doesn't distinguish between initial planning and replanner calls.

## Current Flow

```
Replanner called → agent-1 status = "thinking"
  → Provider cold start (60-180s) → no streaming chunks
  → PlannerThinkingPanel checks: phase !== "planning" && !hasStream && !isThinking
  → Panel hides (phase is "executing", no stream, isThinking might be false)
  → User sees nothing for 11 minutes
```

## Solution: Two Changes

### 1. Fix PlannerThinkingPanel Visibility

The panel should show whenever agent-1 is "thinking", regardless of phase:

```tsx
// BEFORE (line 227):
if (phase !== "planning" && !hasStream && !isThinking) return null;

// AFTER:
if (!isThinking && !hasStream) return null;
// Show whenever planner is thinking OR has streaming text
// regardless of which phase we're in
```

This means the panel appears during:
- Initial planning phase (existing behavior)
- Replanner calls during execution (new behavior)
- Planner fallback attempts (new behavior)
- Any time agent-1 is "thinking"

### 2. Persist Thinking Text to Transcript

Currently, streaming text is ephemeral — deleted when the final response arrives.
For the planner specifically, the thinking text is valuable and should be preserved.

**Option A**: Add thinking text as a system entry in the transcript when the
planner's turn completes. This is simpler but mixes concerns.

**Option B**: Extend Plan 1 (streaming transcript persistence) to work for ALL
agents, not just workers. The planner's thinking text would become an
`agent-stream` transcript entry, same as workers.

**Recommendation**: Option B — it's the same mechanism, just broader. The
`PlannerThinkingPanel` already renders the streaming text; converting it to a
persistent transcript entry gives the user a permanent record.

### 3. Wire Replanner Context to Manager

The replanner's `promptPlannerSafely` is wired through `contextBuilders.ts`
line 250, which calls `r.promptPlannerSafely(primaryAgent, promptText, ...)`.
This eventually calls `promptAgent` which passes `manager` to `promptWithFailover`.
So streaming SHOULD work for replanner calls — the issue is just the panel visibility.

But let me verify the replanner context has `emitAgentState`:

The `ReplanContext` interface (replanManager.ts line 41) has `promptPlannerSafely`
but not `emitAgentState`. However, `promptPlannerSafely` calls `promptAgent`
which calls `ctx.emitAgentState` — and `ctx` here is the `PromptContext` from
`contextBuilders.ts` line 448, which includes `emitAgentState` via
`r.emitAgentState` (line 315).

So streaming IS wired for replanner calls. The issue is purely the panel visibility.

## Files to Change

1. **`web/src/components/PlannerThinkingPanel.tsx`** — Fix visibility check:
   - Remove `phase !== "planning"` from the hide condition
   - Show whenever `isThinking` or `hasStream` is true

2. **`web/src/state/store.ts`** (Plan 1 dependency) — When Plan 1 is implemented,
   the planner's streaming text will be preserved as `agent-stream` entries.
   No additional changes needed here — the same mechanism works for all agents.

## Edge Cases

- **Planner finishes thinking**: Panel disappears when `isThinking` becomes false
  AND streaming buffer is cleared. If Plan 1 is implemented, the thinking text
  persists as a transcript entry above the final response.
- **Multiple planner turns**: Each turn gets its own streaming bubble. Old bubbles
  are converted to transcript entries (Plan 1). New bubbles appear for the current turn.
- **Replanner + workers simultaneously**: Workers have their own streaming bubbles.
  Planner has its own. Both visible simultaneously.

## How the Council Brain Would React (Case Study)

If the council brain (Plan 7) were analyzing this run, it would observe:

1. **Interaction chain**: Agent 1 "thinking" for 11 minutes → replanner skip →
   auditor found 2 unmet → workers fixed → auditor confirmed. The 11-minute
   gap is invisible in the transcript.

2. **Pattern detection**: "Planner thinking duration > 5 minutes with no
   streaming data visible" — this is a new exception pattern the brain would
   capture as a `worker_declined` or `empty_response` equivalent.

3. **Root cause analysis**: The brain would identify that the `PlannerThinkingPanel`
   visibility check is too restrictive — it hides when it should show. The brain
   would propose: "Relax PlannerThinkingPanel visibility to show whenever agent-1
   is thinking, regardless of phase."

4. **Patch generation**: The brain would generate the exact fix we're proposing:
   change line 227 of `PlannerThinkingPanel.tsx` from
   `phase !== "planning" && !hasStream && !isThinking` to
   `!isThinking && !hasStream`.

5. **Priority**: This is a "high" priority fix — it directly impacts user trust
   in the system. If the planner silently thinks for 11 minutes with no feedback,
   the user assumes the system is broken.

The council brain would also flag the **design gap**: the replanner reuses the
planner agent (index 1) but the UI doesn't distinguish between planning phases.
A better design would have the replanner use a different agent index, or the
panel would track which "mode" the planner is in (initial planning vs replanner).

## Testing

1. Unit test: `PlannerThinkingPanel` renders when `phase === "executing"` AND
   `isThinking === true`
2. Integration test: Start a run, let a todo go stale, verify the planner
   thinking panel appears during replanner calls
3. Visual test: During a long replanner call (>30s), verify the panel shows
   streaming text or "thinking Ns..." status
