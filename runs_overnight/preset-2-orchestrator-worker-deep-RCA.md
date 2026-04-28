# Preset 2 — orchestrator-worker-deep — RCA

- **runId**: `80a1ca98`
- **target**: same `multi-agent-orchestrator` clone (now with prior commits from preset 1)
- **preset**: orchestrator-worker-deep, 4 agents, 3 rounds
- **directive**: "Analyze supervisor.ts retry-with-backoff and propose a refactor"
- **outcome**: `early-stop` after 6m 45s
- **commits**: 0 / files: 0

## Failure mode

`Stop detail: orchestrator-silenced (2 consecutive empty plans)`

The orchestrator (lead agent in OrchestratorWorkerRunner / OrchestratorWorkerDeepRunner) emitted 2 consecutive empty plans, triggering the early-stop guard.

This is the SAME root-cause family as preset 1 (likely XML tool-call markers leaking + the actual content being empty / `[]`). The orchestrator-worker runners have their own appendAgent path that does NOT yet run `extractToolCallMarkers`. When the planner emits 30+ XML markers as text, parsing the tail as JSON arrays returns empty.

## Confirmation that #229 fix is needed in non-blackboard runners too

Currently `extractToolCallMarkers` only runs in `BlackboardRunner.appendAgent`. The other 6 presets (orchestrator-worker, orchestrator-worker-deep, council, debate-judge, role-diff, mapreduce, stigmergy, round-robin) all have their own transcript-entry construction paths. Each needs the same two-stage strip:

1. `extractThinkTags` (already in BlackboardRunner; not in others)
2. `extractToolCallMarkers` (just added to BlackboardRunner; not in others)

**Follow-up queued (#230)**: extract a shared `buildAgentEntry(agent, text): TranscriptEntry` helper from BlackboardRunner.appendAgent and use it across all runners. This is ~10 lines per runner × 6 runners.

## What worked

- The dev server's status endpoint stayed responsive throughout
- Monitor fired the terminal phase event reliably
- The early-stop guard correctly bounded the wasted compute (6m 45s, not the full 1h cap)
