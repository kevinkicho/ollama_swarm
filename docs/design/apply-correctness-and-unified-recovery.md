# Apply Correctness and Unified Grounded Recovery (RR-A)

| Field | Value |
|-------|-------|
| **Author** | Residual reliability program |
| **Date** | 2026-07-17 |
| **Revision** | 1 |
| **Status** | **Mostly shipped on `main`** (C1–C4 + applyOrGroundedRepair + auditor repair + wrap-up fail-closed). Optional polish only. |
| **Program** | [`residual-reliability-program.md`](./residual-reliability-program.md) (RR-A) |
| **Depends on** | Shipped grounding stack (`ApplyMissReport`, `buildHunkRepairPrompt`, emit-only repair) |
| **Related code** | `applyHunks.ts`, `applyMissReport.ts`, `councilWorkerRunner.ts`, `workerSelfConsistency.ts`, `WorkerPipeline.ts`, `auditorPendingCommits.ts`, `wrapUpApplyPhase.ts`, `BaselineRunner.ts` |

---

## Overview

After the eee6718f grounding stack, apply/repair **exists** but is **unsafe in a few paths** and **inconsistent across entrypoints**. This design:

1. Removes **silent corrupt apply** behaviors.
2. Introduces a **single `applyOrGroundedRepair` core** used by council, blackboard, auditor, and wrap-up.
3. Guarantees **never propose/commit hunks that pure apply just proved fail**, unless a grounded repair dry-run accepts replacements.

This is the highest-leverage next program after live validation of the shipped stack.

---

## Background & Motivation

### Residual failure modes (code-verified)

| # | Mode | Location | Harm |
|---|------|----------|------|
| C1 | `create` on existing file → `replace` with `search = content.slice(0, 2000)` | `councilWorkerRunner.tryWorkerPrompt` | Half-file “success” corruption |
| C2 | Multi-match `replace` auto-applies unique **line-suffix** | `applyHunks` replace case | Wrong occurrence applied silently |
| C3 | Repair fails → still `proposeCommitQ(originals)` | `workerSelfConsistency.finalizeWorkerHunks` | Auditor thrash; known-bad commit proposals |
| C4 | Wrap-up: any dry-run success → apply **all** synthesizer hunks; baseline fail-open per file | `wrapUpApplyPhase`, `applyBaselineHunks` | Partial multi-file land; integrity blind |
| C5 | Council stage-2 uses parse-shaped repair for apply misses | `executeTodoWithRetryChain` | Ungrounded second stage after good stage-1 repair |
| C6 | Auditor batch apply: reject only, no grounded repair | `auditorPendingCommits` | Miss report discarded |
| C7 | At most one grounded repair; multi-file repair context is single-file | council nested repair | Incomplete recovery |

### Existing strengths (keep)

- `ApplyMissReport` + fail-closed `replace_between` uniqueness.
- `buildHunkRepairPrompt` v2 + emit-only profile + no literature on repair.
- Council nested repair with fresh disk re-read (stage 1).
- Blackboard dry-run accept gate when repair **succeeds**.
- `applyIntegrity` counters (extend, do not replace).

---

## Goals & Non-Goals

### Goals

1. **Zero** known silent half-file or wrong-occurrence auto-apply paths.
2. **One** recovery quality bar for all apply entrypoints.
3. Blackboard **never** proposes hunks that failed dry-run without accepted repair.
4. Wrap-up uses **fail-closed** subset apply (or total re-prompt), and contributes to `applyIntegrity`.
5. Council stage-2 **branches** on failure class (parse vs apply miss).
6. Unit tests lock each C1–C4 regression.

### Non-Goals

1. Fuzzy / AST patching.
2. Soft multi-match “first wins” apply.
3. Unlimited multi-round repair loops (cap remains 1 grounded repair per attempt unless explicitly extended later).
4. Research / catalog / stream changes (RR-C / RR-E).

---

## Key Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Remove create→2KB replace coerce**; use `write` if policy allows full rewrite, else fail with clear error | Prevents silent truncation edits |
| D2 | **Remove auto-apply of unique multi-match suffixes** for `replace`; return `search_not_unique` + candidates only | Align with `replace_between`; wrong-occurrence risk > convenience |
| D3 | **`applyOrGroundedRepair` pure+IO helper** is the only place that chains apply → miss → re-read → repair prompt → model → re-apply | Stops path drift |
| D4 | **Blackboard: fail todo on unrepaired miss** (no propose) | Auditor is not a trash can for known-bad hunks |
| D5 | **Wrap-up: apply only dry-run-clean files/hunks** OR total miss → fallthrough re-prompt; no fail-open global apply of mixed set | Predictable artifacts |
| D6 | **Council stage-2:** parse/schema → existing parse repair; apply miss → grounded repair / full re-prompt with miss, not parse envelope | Stops ungrounded “repair” |
| D7 | **Auditor: one grounded repair attempt** before reject | Same quality as worker path |
| D8 | **`applyIntegrity` path tags** optional: `council \| blackboard_preflight \| auditor \| wrapup` | Compare rates fairly |

---

## Proposed Design

### 1. Correctness fixes in `applyHunks`

```text
replace multi-match:
  BEFORE: try unique suffix shorten → apply if unique
  AFTER:  always fail with search_not_unique + uniqueCandidates via expandToUnique / findUniqueSubstrings
          (optional later: env ALLOW_REPLACE_MULTI_MATCH_SHORTEN=1 for emergency; default off)
```

Telemetry: if a legacy flag re-enables shorten, count `silentReplaceShorten` under `applyIntegrity` extras (or missByKind key `search_soft_shorten`).

### 2. Create-on-existing policy

In council (and any other coerce sites):

```text
if op===create && file exists:
  → fail with kind "other" message: use write/replace/replace_between
  OR if RunConfig.allowCreateToWriteCoerce: convert to op write (full content)
Never: search = first 2000 chars of existing file
```

### 3. `applyOrGroundedRepair` core

```typescript
// server/src/swarm/applyOrGroundedRepair.ts (new)

export type ApplyPath =
  | "council"
  | "blackboard_preflight"
  | "auditor"
  | "wrapup"
  | "propose_hunks";

export interface ApplyOrRepairInput {
  runId?: string;
  path: ApplyPath;
  cloneRoot: string;
  hunks: Hunk[];
  /** Current texts for expected files; will re-read miss file from disk on repair */
  currentTextsByFile: Record<string, string | null>;
  callModel: (prompt: string) => Promise<string>; // emit-only caller responsibility
  maxGroundedRepairs?: number; // default 1
}

export interface ApplyOrRepairResult {
  ok: boolean;
  newTextsByFile?: Record<string, string>;
  error?: string;
  miss?: ApplyMissReport;
  repaired: boolean;
  repairAttempts: number;
}
```

Algorithm:

```text
1. applyHunks(currentTexts, hunks)
2. if ok → noteApply success; return
3. note miss (if path counts integrity)
4. if !isRepairableApplyMiss(miss) OR repairAttempts exhausted → return fail
5. re-read miss.file from disk into map
6. prompt = buildHunkRepairPrompt(hunks, error, map, { miss })
7. model text → parse hunks (same parsers as path)
8. dry-run / apply again
9. if ok → noteRepairSuccess + note miss kind once if policy requires; return repaired
10. noteRepairFailure; return fail (do not return original hunks as ok)
```

**Call sites migrate to this helper** (thin wrappers keep existing signatures temporarily):

| Call site | Change |
|-----------|--------|
| `councilWorkerRunner` nested repair | Call core; remove duplicate logic |
| `workerSelfConsistency` preflight | Call core; **on fail → failTodoQ**, never propose originals |
| `auditorPendingCommits` | On batch fail, if single-todo hunks repairable → one core repair then re-apply; else reject with miss |
| `wrapUpApplyPhase` | Dry-run all; apply only clean subset **or** if policy `strict` and any miss → fallthrough only; use core for fallthrough worker path if applicable |

### 4. Blackboard propose policy

```text
finalizeWorkerHunks:
  result = applyOrGroundedRepair(...)
  if result.ok → proposeCommitQ(result.hunks / texts)
  else → failTodoQ(reason = result.error, structured miss in metadata)
```

### 5. Wrap-up fail-closed

```text
dryRunHunks → { okFiles, missByFile }
if wrapUpStrict (default true):
  if any miss and zero okFiles → fallthrough re-prompt only
  if mixed → apply only okFiles (document in system line); optional fallthrough for misses
else (legacy):
  current behavior (discouraged)
```

Wire `noteApply*` / `noteApplyMiss` for wrap-up path so digest shows wrap-up activity.

### 6. Council stage-2 branching

```text
if primary fail:
  if isApplyMiss(reason/miss) → stage2 = grounded re-prompt (fresh buildWorkerUserPrompt + miss block)
                                 OR second call to applyOrGroundedRepair if hunks parseable
  else if isParse/schema → existing buildWorkerRepairPrompt
  else → full re-prompt stage 3
```

### 7. Persist miss on todo (minimal for RR-A)

```typescript
// on fail paths:
todo.lastApplyMiss = {
  kind, needle, matchCount, uniqueCandidates: string[], nearbyExcerpt: string, message, at: Date.now()
}
```

Consumers in RR-B expand first-pass use; RR-A only **writes** the field and includes it in fail reasons.

---

## Observability

Extend `applyIntegrity` (additive fields optional):

```typescript
applyIntegrity?: {
  attempts: number;
  applied: number;
  missByKind: Record<string, number>;
  repairSuccesses: number;
  repairFailures: number;
  /** NEW optional */
  byPath?: Record<ApplyPath, { attempts: number; applied: number; repairSuccesses: number; repairFailures: number }>;
}
```

Back-compat: omit `byPath` when empty.

---

## Alternatives considered

| Alternative | Why rejected |
|-------------|--------------|
| Keep multi-match shorten as default | Wrong-occurrence corruption risk |
| Soft-apply first match | Silent wrong edit (program non-goal) |
| Only fix council, leave blackboard | Highest thrash is propose→auditor |
| Infinite repair loops | Cost / thrash; model will not always converge |

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Fail-closed multi-match increases visible fails short-term | Repair candidates + grounded repair already exist; measure repairSuccess |
| create→write may rewrite large files | Only under explicit allow flag; default fail with instruction to use write intentionally |
| Auditor repair increases latency | Cap 1; emit-only; skip if not repairable kind |
| Refactor breaks callers | Thin wrappers + extensive unit tests before call-site migration |

---

## Success metrics

1. Unit tests: create-on-existing never produces 2KB prefix replace.
2. Unit tests: multi-match replace never applies without unique full search.
3. Integration-style source tests: blackboard unrepaired miss does not call propose.
4. Wrap-up mixed dry-run does not apply failing files.
5. Live: no half-file corruption reports; applyIntegrity.repairSuccesses meaningful after fails.

---

## PR Plan

Implement sequentially on `main` (or stacked branches only if requested).

### PR 1: Fail-closed multi-match replace + create coerce removal

- **Files/components affected:** `server/src/swarm/blackboard/applyHunks.ts`, `applyHunks.test.ts`, `server/src/swarm/councilWorkerRunner.ts`, related tests
- **Dependencies:** None
- **Description:** Remove unique-suffix auto-apply on multi-match `replace`; always `search_not_unique` + candidates. Remove create→slice(0,2000) replace; fail or optional full `write` under flag. Regression tests for C1/C2.

### PR 2: `applyOrGroundedRepair` core + council migration

- **Files/components affected:** new `server/src/swarm/applyOrGroundedRepair.ts` (+ tests), `councilWorkerRunner.ts`, `applyIntegrityStats.ts`
- **Dependencies:** PR 1
- **Description:** Implement core helper; migrate council nested repair; path-tagged integrity notes; stage-2 branch on apply vs parse.

### PR 3: Blackboard + auditor migration

- **Files/components affected:** `workerSelfConsistency.ts`, `auditorPendingCommits.ts` (or equivalent), tests
- **Dependencies:** PR 2
- **Description:** Preflight uses core; unrepaired miss → failTodo not propose; auditor one repair attempt before reject; persist `lastApplyMiss` on todo when available.

### PR 4: Wrap-up fail-closed + integrity

- **Files/components affected:** `wrapUpApplyPhase.ts`, `BaselineRunner.ts` (applyBaselineHunks policy), tests, `applyIntegrityStats`
- **Dependencies:** PR 2
- **Description:** Apply only dry-run-clean files; system lines for partial; integrity counters on wrap-up; document strict default.

---

## Acceptance checklist

- [x] C1–C4 unit/source regressions green (`applyHunks` fail-closed multi-match + create-on-existing; wrap-up mixed dry-run fallthrough)  
- [x] Council uses core for grounded repair (`applyOrGroundedRepair` in `councilWorkerAttempt`)  
- [x] Blackboard never proposes dry-run failures without accepted repair (`workerSelfConsistency` unrepaired → failTodo)  
- [x] Auditor repair path exists (1× in `auditorPendingCommits`)  
- [x] Wrap-up fail-closed + integrity  
- [x] `validate-grounding-stack.mjs` updated (+ multi-tab smoke, dual-path, applyOrGroundedRepair)  

### Residual (optional)

- Soft multi-match shorten only under explicit env (default remains fail-closed) — already fail-closed by default  
- Path-tagged `applyIntegrity` rate dashboards in UI — counters exist; polish only

---

## Out of scope (later designs)

- Unified anchors / not-found locus → **RR-B**  
- Research local-first → **RR-C**  
- cycleIntegrity → **RR-D**  
