# Agent activity signaling (study notes)

**Status:** Core control-plane fixes landed (2026-07) — single hub, prompt-owned lifecycle, activity in `/status`, sidebar demotion.  
**Context:** Observed during run `d3a99661` — agent-1 streaming dock showed live work while sidebar stayed `ready` (green).

## Problem statement

The app depends on server-side messages from the AI provider (chunked HTTP / gateway stream). Those chunks are honest about *text arriving*. The UI, however, must also answer *what is each agent doing right now?* That second question is not answered by a single protocol today.

## What we have (event bus)

- Typed wire format: `SwarmEvent` union + Zod schemas (`shared/wsProtocol.ts`)
- Server broadcast hub (`RunEventHub`) → WebSocket
- Client receiver: `applyEventToStore` (one switch into zustand)
- Parallel snapshot channel: `GET /api/swarm/status` for reconnect / backfill
- Append-only per-run debug log (`logs/<runId>/debug.jsonl`)

This works well when **one code path owns the full lifecycle**.

## What we lack (activity protocol)

Multiple **independent transmitters** with no binding rules:

| Transmitter | Event(s) | Primary consumer |
|-------------|----------|------------------|
| `AgentManager.markStatus` | `agent_state` | Sidebar (`AgentPanel`) |
| `AgentManager.recordStreamingText` | `agent_streaming` / `agent_streaming_end` | Streaming dock (`StreamingDock`) |
| Runners `opts.emit` | `transcript_append` | Transcript bubbles |
| Some headless prompts | streaming only | Dock only — **no status** |

There is no shared **activity model** (e.g. `activityId`, `phase: started \| streaming \| done`, correlation to prompt). Receivers are separate store slices; UI components derive conflicting views.

### Canonical good path

`DiscussionRunnerBase.runDiscussionAgent`:

1. `markStatus("thinking")` + `emitAgentState` (+ `thinkingSince`)
2. `promptWithFailoverAuto` → streaming via `recordStreamingText`
3. `transcript_append`
4. `markStatus("ready")`

### Known gap paths (council / agent-1)

Direct `promptWithFailoverAuto` **without** `markStatus`, including:

- `CouncilRunner.synthesizeStandup()`
- `councilDecisions.extractActionableTodos()`
- `councilAuditor` audit prompt
- `CouncilRunner` planner fallback (~line 784)
- `councilAdapter.promptAgent` / `promptPlannerSafely` (contract, tier promotion)

`promptWithFailoverAuto` does not set status; passing `manager` only enables streaming.

### Dock vs sidebar “thinking”

`StreamingDock` subtitle `thinking 4s…` = **time since last chunk** (heuristic).  
Sidebar `thinking` = **`agent_state.status` enum** (declared lifecycle). Same word, different semantics.

### Thinking panel vs pseudo-tool XML (2026-07-07)

Explore turns (contract/planner with tools) may leave DeepSeek `<function>…</function>` blocks inside `TranscriptEntry.thoughts` or bubble text. Server `stripAgentText` extracts these into `toolCalls`; the bubble **Thinking** toggle uses `parseThinkingDisplay` to show prose + collapsible **Intended tool calls** (e.g. `read → data/marketPanels.js`) instead of raw XML. See `docs/postmortems/run-94224a3e.md`.

### REST poll secondary hazard

`applyStatusSnapshotToStore` upserts agents with `status` + `model` only (no `thinkingSince`). Can overwrite WS `thinking` state on hydrate. Less relevant for headless paths where mirror never flips to `thinking`.

## Symptom example (d3a99661 @ ~21m34s)

Agent-1 dock showed `done · 6,051 chars · 5s total` with JSON todo array (`description` + `expectedFiles`, max 6 items) — format from **standup synthesis**, not standup turn (`issue` / `file` / `severity`). Sidebar remained `ready` for the entire 5s generation.

## Architectural direction (implemented 2026-07)

One emission plane per run:

- **Single `RunEventHub`** created via `createHub(runId)` with broadcast + eventLogger + debug sinks; `createManager(runId, hub)` + runner `wrappedEmit` share it (no double-broadcast).
- **Prompt layer** (`promptWithRetry`) owns lifecycle when the caller has not already marked thinking: `markStatus(thinking)` → streaming activity → `markStatus(ready)` (or activity `done` when caller owns ready).
- **`AgentManager.recordAgentState` merges** — partial runner emits cannot wipe `activityLabel` / `thinkingSince`.
- **`agentActivity` in REST `/status`** + hydrate into the client store (not WS-only).
- **UI single projection** (`viewAgentActivity`): demotes sticky thinking when activity is `done`; ignores stale activity when control is idle (dock-aligned); primary line = task · phase · elapsed.

## Related files

| Area | Path |
|------|------|
| Sidebar status | `web/src/components/AgentPanel.tsx` |
| Streaming dock | `web/src/components/transcript/StreamingDock.tsx` |
| Client dispatch | `web/src/state/applyEvent.ts` |
| Status hydrate | `web/src/state/swarmStoreHydrate.ts` |
| Status mirror | `server/src/services/AgentManager.ts` |
| Good reference | `server/src/swarm/DiscussionRunnerBase.ts` |
| Standup synthesis gap | `server/src/swarm/CouncilRunner.ts` → `synthesizeStandup()` |

## Recall trigger

Revisit when fixing agent sidebar/status drift, designing WS protocol v2, or unifying “agent busy” across Board / Drafts / Transcript.
---

## Implemented (2026-07) — compounding without hard rules

**progress-ledger.json** per run (logs/<shortRunId>/) — observations from standup findings, commits, skips, failures, synthesis notes. Rendered as informational SHARED RUN PROGRESS blocks in standup, synthesis, worker, and cycle-1 todo-extraction prompts.

**Standup fallback:** if agent-1 merge yields 0 todos, enqueue from parsed agent standup JSON.

Code: server/src/swarm/councilProgressLedger.ts, councilStandupFallback.ts.
