# Live-run preflight — analysis of last real runs + fixes (2026-07-16/17)

| Field | Value |
|-------|-------|
| **Runs analyzed** | `eee6718f-03f3-45dd-a3a2-593076734102`, `9f449937-a060-49e6-9417-aba2774dfb16` |
| **Note** | Only two substantial council summaries under `server/logs/` after recover-me test stubs; third-party older runs lacked `summary.json` |
| **Code tip after fixes** | See commit on `main` after this doc |

## Run snapshots

| Run | Wall | Files | Stop | Dominant transcript patterns |
|-----|------|-------|------|--------------------------------|
| **eee6718f** | 36m | 48 | user | JSON parse `<think>` (~54), literature tool_loop (~20), apply not_unique / search not found, permanent-skip noop, cycle 1–3 thrash |
| **9f449937** | 22.6m | 5 | user | Wrap-up 16→0, extractActionableTodos abort, JSON parse `<think>`, literature tool_loop, permanent-skip |

**Missing from both summaries:** `applyIntegrity`, `cycleIntegrity`, `researchIntegrity` (tracking started late or counters not wired on council todo outcomes / wrap-up).

## Root causes (code-truth, not “model is dumb”)

1. **Council worker emit path allowed tools without `ollamaFormat: "json"`** → pure-think blobs; salvage often failed → stage-2 still ran but thrash continued.
2. **Stage-2 always used JSON/envelope repair framing** even after apply misses that already got grounded repair → wrong recovery class.
3. **Council literature was web-first** (catalog only after fail/blackout) while blackboard was local-first → avoidable tool loops on doc-rich clones.
4. **`recordCycleFail` / `recordCycleTodoSuccess` unwired on council** → empty `cycleIntegrity` digests.
5. **Wrap-up used `applyBaselineHunks` partial multi-file land** and no applyIntegrity notes.
6. **create→write auto-coerce** could silently full-overwrite existing files.
7. **`end_not_found` had empty `uniqueCandidates`** despite being repairable.

## Fixes landed (this preflight)

| Fix | Where |
|-----|--------|
| Emit-only + `ollamaFormat: "json"` on council worker primary/JSON-repair | `councilWorkerRunner.ts` |
| Stage-2 class-aware: apply_miss → fresh-disk re-emit; else JSON repair | `councilWorkerRunner.ts` |
| Local-first catalog (≥200 chars) before web literature | `councilWorkerRunner.ts` |
| `recordCycleFail` / `recordCycleTodoSuccess` on todo settle | `councilWorkerRunner.ts` |
| Fail-closed create-on-existing (no silent write) | `councilWorkerRunner.ts` |
| Fail-closed wrap-up multi-file apply + integrity counters | `wrapUpApplyPhase.ts` |
| `end_not_found` unique candidates | `applyMissReport.ts` |
| Stronger `classifyCycleFailReason` (schema / endExclusive) | `cycleIntegrityReport.ts` |
| Empty-execution Brain RECONFIG + OpenAlex/Crossref + propose_hunks miss | prior polish commit |

## What to watch on the next live run

- Summary should include **`applyIntegrity`** (attempts/missByKind/repairs) and **`cycleIntegrity`** (failByBucket + todosSucceeded).
- Literature system lines: prefer **Local catalog (local-first)** over tool-loop thrash when catalog hits.
- Primary worker failures: fewer `JSON parse failed: Unexpected token '<'` if Ollama honors format.
- Apply thrash: stage-2 log should say **apply-class: fresh-disk re-emit** not JSON repair framing.
- Wrap-up: either all files land or 0 (no silent partial multi-file).

## Still open (not blocking this preflight)

- Unified `applyOrGroundedRepair` adoption on all paths (auditor only today).
- `todo.lastApplyMiss` persistence across retries.
- Deterministic `uniqueCandidates[0]` try (flag, default off).
- Blackboard empty-plan streak RECONFIG parity with council empty-execution.
- Multi-match `windowFileWithAnchors` first-match windowing.
