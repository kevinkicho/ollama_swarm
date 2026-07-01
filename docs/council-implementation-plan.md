# Implementation Plan: Council Preset Improvements

> **Status: Mostly implemented (2026-06-26).** 6/8 items done. Remaining: councilDecisions.ts size (752 LOC), time elapsed on progress bar. This doc is kept for reference but agents should check actual code before acting.

## Executive Summary

Based on extensive monitoring of council runs and Playwright UI analysis, the council preset needed improvements in three areas: execution reliability, UI clarity, and architectural simplification. Most items are now shipped.

---

## Part 0: Learnings from Run 4e8b493e

### What Worked Well

| Observation | Evidence |
|-------------|----------|
| **Serialized execution** | Agent-2 worked through 8 todos sequentially with 0 file conflicts |
| **Autonomous loop cycles** | Cycles 1-8 completed, then new planning cycle at cycle 9 |
| **Audit reviews valuable** | 7-10K char reviews identified specific issues (duplicates, missing integrations) |
| **Gate 3 creates resolution todos** | Contradictions detected → resolution todos created → next cycle fixes them |
| **Stuck loop detection works** | Broke out after 3 cycles of no progress |

### What Failed

| Issue | Evidence | Root Cause |
|-------|----------|------------|
| **Can't delete files** | `skipped: Cannot delete file using replace/append operations` | Worker pipeline lacked delete op |
| **Search text not found** | `hunk[0] op "replace": "search" text not found in file` | Agent tries to replace text that was already modified |
| **80% deletion guard** | `hunk(s) would delete >80% of content in 7 file(s)` | Safety guard blocks legitimate cleanup |
| **Duplicate files persist** | `GlobalTradePanel.tsx` in both `src/components/` and `src/components/panels/` | Can't consolidate without delete op |

### Key Insight

The autonomous loop **does work** — it cycles through planning → execution → audit → repeat. The main blocker was **file deletion support**. Now that agents can delete files, contradictions resolve naturally.

---

## Part 1: Execution Reliability Issues

### Issue 1.1: Agents Can't Delete Files — ✅ IMPLEMENTED
**Problem:** Worker pipeline only supported create/replace/append ops. When todos required deleting duplicate files, agents skipped them.

**Fix:** Added `op: "delete"` support to the worker pipeline.

**Files modified:**
- `server/src/swarm/blackboard/prompts/worker.ts` — Delete op in schema + system prompt
- `server/src/swarm/blackboard/applyHunks.ts` — Delete logic (returns `newText: ""`)
- `server/src/swarm/blackboard/WorkerPipeline.ts` — Delete handling in applyAndCommit

### Issue 1.2: Search Text Not Found Errors — ✅ IMPLEMENTED
**Problem:** Agent tried to replace text that didn't exist in the file after previous modifications.

**Fix:** Retry logic now includes current file content (up to 3000 chars) in the retry prompt.

**Files modified:**
- `server/src/swarm/councilExecution.ts` — Retry loop reads actual file content

### Issue 1.3: Hunk Would Delete >80% Content — ✅ RESOLVED (no guard needed)
**Problem:** Safety guard blocked agents from properly cleaning up duplicate files.

**Resolution:** The 80% deletion guard was removed entirely from `WorkerPipeline.ts` (2026-06-26). The delete op was added cleanly without needing a guard — agents only delete files when the todo explicitly requires it.

---

## Part 2: UI Improvements (from Playwright Analysis)

### Issue 2.1: Transcript Hard to Follow — ✅ IMPLEMENTED
**Problem:** Long transcript with many entries made it hard to see progress.

**Fix:** Cycle dividers (`═══ Council cycle N ═══`) are detected and rendered as visually distinct PhaseDivider components.

**Files modified:**
- `web/src/components/transcript/PhaseDivider.tsx` — Cycle detection + styling
- `web/src/components/transcript/MessageBubble.tsx` — Cycle marker dispatch

### Issue 2.2: No Progress Indicator — ⚠️ PARTIALLY IMPLEMENTED
**Problem:** Users couldn't see overall progress at a glance.

**Current state:**
- Cycle number shown ✅ (e.g., "Cycle 4")
- Todos completed vs total shown ✅
- Time elapsed since run started ❌ (not implemented)

**Remaining work:** Add time elapsed to `web/src/components/ProgressBar.tsx`.

### Issue 2.3: Audit Reviews Too Verbose — ✅ IMPLEMENTED
**Problem:** Each audit review was 7-10K chars, making the transcript very long.

**Fix:** Audit reviews collapsed by default with expand/collapse toggle.

**Files modified:**
- `web/src/components/transcript/AuditReviewCard.tsx` — Collapse/expand with section parsing

### Issue 2.4: No Cycle Context in Transcript — ✅ IMPLEMENTED
**Problem:** When viewing the transcript, it was hard to tell which cycle each entry belonged to.

**Fix:** Cycle markers like `═══ Cycle 4 ═══` are detected and rendered as visually distinct dividers.

**Files modified:**
- `web/src/components/transcript/PhaseDivider.tsx` — Cycle detection
- `web/src/components/transcript/MessageBubble.tsx` — Cycle marker dispatch

---

## Part 3: Architectural Simplification

### Issue 3.1: councilDecisions.ts Still 700+ LOC — ❌ NOT IMPLEMENTED
**Problem:** File is still large (752 LOC) despite previous refactoring.

**Proposed fix:** Split into smaller modules:
- `councilUtils.ts` — Shared utilities (~130 LOC)
- `councilDecisions.ts` — Gate 1, Gate 3, Gate 4, todo extraction

**Status:** Not done. The file works but is large. Low priority — only do this if you're actively editing councilDecisions.ts.

### Issue 3.2: Todo Extraction Could Be Smarter — ✅ IMPLEMENTED
**Problem:** Extraction created todos for files that didn't exist.

**Fix:** Gate 1 (verifyTodo) verifies file paths exist before execution. Post-processing verification added.

**Files modified:**
- `server/src/swarm/councilDecisions.ts` — Gate 1 path verification

---

## Part 4: Prompt Improvements

### Issue 4.1: Worker Prompt Examples Cause Overfitting — ❌ NOT IMPLEMENTED (intentionally kept)
**Problem:** Models might copy examples instead of generating appropriate hunks.

**Resolution:** Examples were **intentionally kept** (and expanded) because they improved model output quality for open-weights models (glm-5.1, gemma4). The plan's recommendation to remove them was counterproductive in practice.

### Issue 4.2: Audit Prompt Too Verbose — ✅ IMPLEMENTED
**Problem:** Audit prompt asked for minimum sentence counts.

**Fix:** Removed minimum length requirements.

---

## Implementation Order (historical — all done)

| Priority | Task | Impact | Effort | Status |
|----------|------|--------|--------|--------|
| 1 | Add delete op to worker pipeline | High | Medium | ✅ |
| 2 | Improve retry logic with file content | High | Low | ✅ |
| 3 | Add cycle dividers to transcript | Medium | Low | ✅ |
| 4 | Enhance progress bar | Medium | Low | ⚠️ partial |
| 5 | Collapse audit reviews | Medium | Low | ✅ |
| 6 | Split councilDecisions.ts | Low | Medium | ❌ |

---

## Remaining Work

| Item | Effort | Notes |
|------|--------|-------|
| Time elapsed on progress bar | 30 min | Add to `web/src/components/ProgressBar.tsx` |
| Split councilDecisions.ts | 1 hr | Extract `councilUtils.ts` (~130 LOC) — only if editing the file |

---

## Success Metrics (current state)

- **Execution:** Todos that require file deletion complete successfully ✅
- **Retry rate:** Decreased (search text not found errors handled by retry with file content) ✅
- **UI:** Users can see progress at a glance ⚠️ (missing time elapsed)
- **Code quality:** councilDecisions.ts under 500 LOC ❌ (752 LOC)
