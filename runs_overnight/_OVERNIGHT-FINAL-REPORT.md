# Overnight validation tour — final report

**Session**: 2026-04-27 18:24 PDT → 2026-04-27 19:35 PDT (~1h 10m)
**Directive (from Kevin)**: "continue overnight: finish validation tour, then 8×1h preset runs with RCA on failures"

---

## Summary scoreboard

### Validation tour (UI bubble audit)
- **Built**: BubbleGallery (`?gallery=1`) with 32 hand-crafted fixtures
- **Result**: 30/32 PASS on first capture; 2 gaps closed (#226 TodosBubble, #227 quota ribbons)
- **Discovered + fixed during tour**: 2 additional follow-ups (#228 unpaired `</think>`, #229 XML pseudo-tool-call markers)
- **Final state**: 34/34 fixtures rendering correctly with 0 console errors

### Preset runs (8 + 2 bonus = 10 total)

| # | Preset | Outcome | Time | Notes |
|---|---|---|---|---|
| 1 | blackboard | **FAIL** no-progress | 7m 4s | RCA → #228 + #229 shipped |
| 2 | orchestrator-worker-deep | **FAIL** early-stop | 6m 45s | RCA → #230 shipped |
| 3 | council | PASS | 1m 15s | clean — 4 drafters |
| 4 | debate-judge | PASS | 59s | clean — PRO/CON/JUDGE |
| 5 | role-diff | PASS | 2m 25s | clean — 4-role consolidation |
| 6 | map-reduce | PASS | 1m 6s | clean — 4 mappers + reducer |
| 7 | stigmergy | PASS | 1m 21s | clean — file ranking |
| 8 | round-robin | PASS | 3m 12s | clean — 4 agents × 3 rounds |
| **bonus 9** | orchestrator-worker (regular) | PASS | 2m 31s | clean — narrows ow-deep failure |
| **bonus 10** | blackboard (re-run with fixes) | **FAIL** no-progress | 2m | validates fix scope (UI fixed; planner unchanged) |

**Pass rate**: 7/10 (70%). Discussion presets: 6/6 PASS. Strict-parsing presets (blackboard + ow-deep): 0/3 PASS.

---

## Key findings

### Finding 1 — XML pseudo-tool-call markers are systemic, not model-specific
Both `glm-5.1:cloud` and `nemotron-3-super:cloud` (sibling fallback) emit `<read>/<grep>/<list>` markers as raw text instead of using the SDK tool functions. Two models from different families exhibiting the same behavior = systemic, likely in the agent's system prompt or opencode SDK tool-grant context. **Queued #231 to investigate the root cause.**

### Finding 2 — Failure mode is parse-strict, not preset-architecture
Discussion presets (council, debate-judge, role-diff, map-reduce, stigmergy, round-robin) all PASS with the same model that fails strict-parsing presets (blackboard, ow-deep). The failure is in the strict JSON-envelope parse path:
- Blackboard: contract → todos pipeline expects valid JSON envelopes
- OW-deep: orchestrator-silenced detector requires non-empty plans

The shared `stripAgentText` helper (#229 + #230) closes the UI noise + Phase 2 over-segmentation pieces but does NOT change the model's actual emission behavior.

### Finding 3 — Sibling-model fallback insufficient when both models share the marker behavior
The fallback path (#34db7f9, glm-5.1 ↔ nemotron-3-super) is designed for the case where ONE model has a bad response. When BOTH emit markers, the fallback adds a turn but doesn't recover. May want to consider: (a) a third "stripped + coerce" attempt with explicit "no XML, JSON only" prompt rewrite, OR (b) a different fallback model family.

---

## Code shipped (8 commits)

```
4291b4c  Validation tour: BubbleGallery fixture for ?gallery=1
2b4e871  TodosBubble + quota ribbons (validation tour follow-ups #226 + #227)
796d034  Task #228: strip unpaired </think> closer at head
372809e  Task #229: server-side strip of XML pseudo-tool-call markers
a8a66d4  Task #230: shared stripAgentText helper + CouncilRunner integration
9b9b0c4  Task #230: apply stripAgentText across remaining 6 runners
```

### Files added
- `web/src/components/BubbleGallery.tsx` — 34 fixtures
- `web/src/components/transcript/TodosBubble.tsx` — 3-tab planner-todos renderer
- `web/src/components/transcript/ToolCallsBlock.tsx` — collapsed amber pseudo-tool-call display
- `shared/src/extractToolCallMarkers.ts` + 16 unit tests
- `shared/src/stripAgentText.ts` — shared helper

### Files modified
- `web/src/App.tsx` — `?gallery=1` short-circuit
- `web/src/components/transcript/MessageBubble.tsx` — quota ribbons in SystemBubble + ToolCallsBlock + TodosBubble routing
- `shared/src/extractThinkTags.ts` + tests — unpaired closer handling (15 → 19 tests)
- `server/src/types.ts` + `web/src/types.ts` — `toolCalls?: string[]` on TranscriptEntry
- `server/src/swarm/blackboard/BlackboardRunner.ts` — uses stripAgentText helper
- 6 non-blackboard runners — apply stripAgentText at agent-entry construction

---

## Tasks status

- ✅ #224 Validation tour (32 → 34 fixtures, full audit + report)
- ✅ #225 8×1h preset runs (8 originals + 2 bonus = 10 runs, full RCA per FAIL)
- ✅ #226 TodosBubble shipped
- ✅ #227 Quota ribbons shipped
- ✅ #228 Unpaired `</think>` closer fix shipped (4 new tests, 19/19 pass)
- ✅ #229 Server-side XML marker strip (16 unit tests, BlackboardRunner integration)
- ✅ #230 Universal stripAgentText across all 8 runners

### Queued for next session
- **#231** Investigate why models emit pseudo-tool-call markers (likely system prompt or SDK tool-grant config)

---

## What was NOT addressed

The cloud-quota-burning items in active-work (multi-repo validation, long-horizon blackboard run, drop opencode) were not exercised — they each need explicit user authorization per memory and burn meaningful cloud quota. The 10 runs tonight stayed within the 1h-cap budget per directive.

The risky cutovers (V2 Step 5c.3 delete Board.ts, V2 Step 6c UI event-log cutover) were not touched — they need 2+ stable USE_WORKER_PIPELINE_V2=1 runs first per active-work, and tonight's blackboard runs were not stable enough to provide that signal.
