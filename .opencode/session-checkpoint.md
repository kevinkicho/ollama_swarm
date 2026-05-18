# Session checkpoint

> Last updated: 2026-05-18
> Status: **in_progress**

## Task
Autoresearch Tier 2–3 — test coverage expansion + debt reduction

## Done (previous sessions)
- Tier 0: Full codebase survey complete
- Tier 1: MessageBubble deliverable bubble + AbortController cleanup for 17 polling fetches
- Tier 1: OpenCode Go critical fixes, zombie process prevention, model resolution consolidation
- Tier 2: summarizeAgentJson 16 tests (2748 total)
- Auto-resume plugin with first-idle guard (prevents auto-trigger on fresh session)

## Done (this session)
- **Registered 4 orphaned web test files** (commit f6da841): PlannerThinkingPanel (12), useReplayState (26), costBreakdown (14), store (7). All pass. THREE more orphaned files (RoundRobinRunner 38, RunStatePersister 26, hunkRepair 6) left unregistered — source-inspection tests bit-rotted after refactoring.
- **New tests for 3 untested shared utils** (commit 8d0cb26): stripAgentText (16 tests — think tags, tool calls, semantically-empty detection), extractJson (23 tests — balanced extraction, fenced blocks, nested objects), topology (53 tests — roleForIndex all 11 presets, isRoleStructural, synthesizeTopology, deriveLegacyFields, schema validation).
- **New tests for 2 untested web modules** (commit 2ab3819): agentPalette (11 tests — hueForAgent wrapping/fallback, palette keys), useSegmentSplitter (20 tests — findContentBoundaries, segmentsFromSplitPoints edge cases). Exported findContentBoundaries for testability.
- **Tier 3: Dead code removal** (commit 12579d3): Deleted subtaskPart.ts + its test (zero production imports), StartConfirmModal.tsx (import commented out since 2026-05-03).
- **Tier 4: Deleted 10 archive docs** (commit edbb364): Kept README.md + smoke-tour per queued plan. Trigger: "go delete archive docs".

## Test counts
- Start: 2748
- Current: **2909** (+161)
- All passing, zero failures

## Remaining Tier 2/3 opportunities (deferred)
- 3 orphaned source-inspection tests need rewriting (RoundRobinRunner, RunStatePersister, hunkRepair)
- Web transcript components (12 files, mostly React .tsx — needs jsdom/vitest setup)
- ~40 files >500 lines, ~15 >800 lines — ripe for splitting (SetupForm 1511, swarm route 1224, Orchestrator 1116)
- Dead barrel exports: withProviderPrefix, modelsForProvider, findAgentSpec, getAgentTag — only used in tests
- Thin re-export shims in web (extractJson.ts, formatServerSummary.ts, transcriptSummarize.ts)
- Duplicate imports in index.ts, BlackboardRunner.ts, treeKill.ts
