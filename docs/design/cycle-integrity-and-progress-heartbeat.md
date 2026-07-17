# Cycle Integrity, Empty-Standup Guard, and Progress Heartbeat (RR-D)

| Field | Value |
|-------|-------|
| **Author** | Residual reliability program |
| **Date** | 2026-07-17 |
| **Revision** | 1 |
| **Status** | Proposed |
| **Program** | [`residual-reliability-program.md`](./residual-reliability-program.md) (RR-D) |
| **Depends on** | Prefer RR-A path tags for apply attribution; can start metrics scaffolding in parallel |
| **Related code** | `councilCycleSettlement.ts`, `councilStandup.ts`, `councilAuditCycle.ts`, `productiveProgress.ts`, `deadLoopGuard.ts`, `councilCycleAggregate.ts`, `RunHealthChip.tsx`, `StreamingDock.tsx`, `RunDigestModal.tsx`, summary writers |
| **Related postmortem item** | eee6718f #14 cycle fail residual; #15 wall-clock idle UI |

---

## Overview

Apply and research stacks can succeed while the **run still looks broken** to operators:

- Cycle fails lack a **taxonomy** (`apply` vs `json` vs `no_hunks` vs `tool_loop` vs empty plan).
- **Empty standup / 0-proposal** cycles can advance without durable work.
- **Wall idle** is agent-centric (no chunks), not run-centric (no commits/todos).
- Integrity ribbons are mostly **end-of-run**.

RR-D makes orchestration **truthful and stoppable** without reviving Jaccard as a primary stop.

---

## Background & Motivation

| Symptom | Gap |
|---------|-----|
| 20–36% early cycle fail on eee6718f | Only `applyIntegrity` shipped; other buckets invisible |
| Drafts `N failed` | Double-count risk; no reason chips |
| Synthesized 0 proposals loops | No council empty-queue dead-loop (OW has plan-empty guard) |
| Multi-hour “thinking” with no commits | No `lastProductiveAt` on status |
| Caps-centric RunHealthChip | No progress quiet / fail buckets live |

Autonomous policy already has soft-done, durable progress, wall-clock, resource gates—but **empty execution** and **fail taxonomy** remain thin.

---

## Goals & Non-Goals

### Goals

1. **`cycleIntegrity`** summary field: fail counts by bucket + empty-cycle count.
2. **Empty-standup / empty-execution guard** after N consecutive empty cycles → reconfig or stop.
3. **Run-level progress heartbeat** on `/status` and UI chip.
4. **Live integrity strip** (apply + cycle + optional research blackout).
5. Drafts aggregate uses **summary authority** + last fail reason per todo.

### Non-Goals

1. Jaccard / embedding as primary whole-run stop (see `stream-guards-removed.md`).
2. Guaranteeing zero cycle fails.
3. Replacing audit zero-progress logic—**compose** with it.

---

## Key Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Buckets are structured enums**, not free-text regex at display time | Stable metrics |
| D2 | **Empty execution** = 0 todos enqueued OR 0 settled work with 0 commits in cycle | Captures 0-proposal tax |
| D3 | **N=3** consecutive empty execution cycles default | Aligns with other streak guards |
| D4 | **Durable progress** remains commits / durable met flips / tier (existing `productiveProgress`) | Do not redefine productivity |
| D5 | **Provider idle ≠ orchestration idle** in UI labels | Operator clarity |
| D6 | **Live strip** is read-only status fields (no new WS flood) | Cheap poll path |

---

## Proposed Design

### 1. `cycleIntegrity` contract

```typescript
// shared/src/cycleIntegrityReport.ts

export type CycleFailBucket =
  | "apply_miss"
  | "json_parse"
  | "no_hunks"
  | "tool_loop"
  | "reaper"
  | "noop"
  | "permanent_skip"
  | "schema"
  | "transport"
  | "empty_plan"
  | "other";

export interface CycleIntegrityReport {
  cyclesCompleted: number;
  emptyExecutionCycles: number;
  failByBucket: Partial<Record<CycleFailBucket, number>>;
  /** todos that failed at least once */
  todosFailed: number;
  todosSucceeded: number;
  lastEmptyStreak: number;
  maxEmptyStreak: number;
}
```

Population:

| Event | Bucket |
|-------|--------|
| Apply miss unrepaired | `apply_miss` |
| JSON parse / format fail | `json_parse` |
| Worker returned no hunks | `no_hunks` |
| toolLoopStuck | `tool_loop` |
| Reaper TTL | `reaper` |
| Noop apply / zero write | `noop` |
| Permanent skip | `permanent_skip` |
| Schema validation | `schema` |
| Provider/network | `transport` |
| 0 proposals / 0 todos enqueued | `empty_plan` (+ emptyExecutionCycles++) |

Prefer structured codes from runners when present; map free-text only as fallback with tests.

### 2. Empty-execution dead-loop guard

```typescript
// mirror deadLoopGuard pattern
class EmptyExecutionGuard {
  streak: number;
  onEmptyCycle(): "continue" | "reconfig" | "stop"
  // streak >= N → emit Brain RECONFIG / system line / optional stop if autonomous
}
```

Hook points: after standup+enqueue and after cycle settlement when no durable progress and no todos drained productively.

Compose with `updateZeroProgressStreak` so empty cycles also advance zero-progress where appropriate.

### 3. Progress heartbeat on status

```typescript
// added to run status / RunHealth
lastProductiveAt?: number;      // durable progress clock
lastActivityAt?: number;        // any agent chunk / system activity
zeroProgressStreak?: number;
stuckCycleCount?: number;
emptyExecutionStreak?: number;
orchestrationIdleMs?: number; // now - lastProductiveAt while running
providerIdleAgents?: number;  // agents with no chunks > 60s (existing dock)
```

Update `lastProductiveAt` from same signals as `productiveProgress` (commits, durable met, tier-up).

### 4. Live integrity strip

RunHealthChip / optional IdentityStrip row:

```text
apply 12/15 · miss search_not_found=2 · cycle fail json=1 apply=2 · progress quiet 3.2m · empty streak 0
```

Sources: in-memory `applyIntegrityStats`, `cycleIntegrity` counters, research blackout flag (RR-C).

### 5. Drafts aggregate fix

`councilCycleAggregate.ts`:

- When cycle **Complete:** summary line exists, use it as authority for done/fail/skip counts.
- Attach `lastFailBucket` / reason from latest todo_failed or primary failed system line.
- Stop double-increment from both summary and per-todo lines.

### 6. Summary + digest

Write `cycleIntegrity` via discussion + blackboard summary writers.  
RunDigestModal: new row “Cycle integrity” under apply/stream.

### 7. System events (optional)

Emit compact system lines:

```text
[cycle-integrity] empty_execution streak=2/3
[progress] quiet 240s since last durable progress
```

Avoid spam: rate-limit to once per streak increment.

---

## Alternatives considered

| Alternative | Why rejected |
|-------------|--------------|
| Jaccard as primary stop | Explicitly removed; vocabulary overlap ≠ done |
| Only improve Drafts parsing | Does not stop empty autonomous spins |
| Hard stop on first empty cycle | Too aggressive; N=3 default |

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Bucket misclassification | Prefer structured codes; unit tests for mapper |
| Empty guard stops valid exploration | Only counts execution-phase empty; not pure discussion presets without execution |
| Status payload growth | Small integers only |

---

## Success metrics

1. Live eee6718f-like run produces non-empty `cycleIntegrity.failByBucket` when fails occur.
2. Three consecutive empty execution cycles → system/reconfig action (testable with fake cycles).
3. `lastProductiveAt` advances on commit; chip shows quiet time when frozen.
4. Drafts fail count matches Complete summary within ±0 on fixtures.
5. Design item #14 becomes measurable; #15 has product surface.

---

## PR Plan

### PR 1: cycleIntegrity types + record sites + summary

- **Files/components affected:** new `cycleIntegrityReport.ts`, settlement/worker fail paths, summary types/writers, tests
- **Dependencies:** None  
- **Description:** Define buckets; record at fail/empty; persist on summary.json.

### PR 2: Empty-execution guard

- **Files/components affected:** `deadLoopGuard.ts` or new guard, `councilStandup.ts`, `councilRunCycle.ts` / audit, tests
- **Dependencies:** PR 1  
- **Description:** Streak + reconfig/stop policy; compose zero-progress.

### PR 3: Progress heartbeat status + RunHealthChip

- **Files/components affected:** status builders, store hydrate, `RunHealthChip.tsx`, types, tests
- **Dependencies:** PR 1  
- **Description:** lastProductiveAt / quiet ms / streaks on status + chip labels (provider vs orchestration idle).

### PR 4: Live strip + Drafts aggregate fix + digest row

- **Files/components affected:** `councilCycleAggregate.ts`, `DraftMatrix.tsx`, `RunDigestModal.tsx`, optional strip component
- **Dependencies:** PR 1–3  
- **Description:** Summary-authoritative fails; last reason; digest cycleIntegrity row; live strip fields.

---

## Acceptance checklist

- [ ] cycleIntegrity on summary after fixture multi-fail run/unit assembly  
- [ ] Empty guard fires at N=3  
- [ ] Progress quiet visible on chip  
- [ ] Drafts no double-count on Complete fixtures  
- [ ] Distinguishes provider stall vs no durable progress in UI copy  

---

## Related

- `docs/postmortems/run-d3a99661.md` (0-proposal cycles)  
- `productiveProgress.ts`, `councilAuditCycle.ts`  
- RR-C `researchIntegrity` may appear on same strip  
