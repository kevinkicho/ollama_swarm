# First-Pass Grounding and Mid-Turn Apply Tools (RR-B)

| Field | Value |
|-------|-------|
| **Author** | Residual reliability program |
| **Date** | 2026-07-17 |
| **Revision** | 1 |
| **Status** | Proposed |
| **Program** | [`residual-reliability-program.md`](./residual-reliability-program.md) (RR-B) |
| **Depends on** | **RR-A** (unified recovery + fail-closed multi-match) |
| **Related code** | `autoAnchor.ts`, `windowFile.ts`, `workerTodoPrep.ts`, `councilWorkerRunner.ts`, `ToolDispatcher.ts` (`propose_hunks`), `applyMissReport.ts`, replan paths |

---

## Overview

Grounded **repair** recovers many misses, but first-pass prompts still:

- Use **different anchor pipelines** on council vs blackboard.
- Window multi-key files to the **first** match only.
- Put **file head** as nearby excerpt when search is invented.
- Leave `end_not_found` and mid-turn `propose_hunks` under-powered.

RR-B raises **first-pass and mid-turn** quality so fewer repairs fire and repairs that do fire have better locus.

---

## Background & Motivation

| Gap | Today | Cost |
|-----|--------|------|
| Council vs blackboard anchors | Council: description extract only; Blackboard: autoDetect when planner empty | Same todo, different windows |
| Auto-detect skips small files / weak keywords | Threshold + Capitalized/quoted bias | Middle sections of large files invent anchors |
| `windowFileWithAnchors` first `indexOf` | Wrong section for repeated titles | Classic panelRegistry multi-section |
| Not-found excerpt | File head (~11 lines) | Repair prompt useless for invented needles |
| `end_not_found` | Not in `REPAIRABLE_APPLY_MISS_KINDS` | Cold fail |
| `propose_hunks` | Crude 40-char excerpt | Mid-turn lag vs post-prompt repair |
| `lastApplyMiss` on todo | Written in RR-A; unused in seed | Re-discovery every attempt |

---

## Goals & Non-Goals

### Goals

1. **One** `mergeAnchorsForTodo(...)` used by council, blackboard prep, replan, wrap-up fallthrough.
2. Prefer **unique** anchors; surface multi-match line numbers when not unique.
3. Better **not-found locus** for nearbyExcerpt (similarity / longest shared line).
4. `end_not_found` repairable with candidates.
5. `propose_hunks` returns full `ApplyMissReport` JSON-ish structure.
6. Optional **deterministic candidate apply** (flag, default off).

### Non-Goals

1. Full fuzzy patching / diff3.
2. Always full-file prompts (token blow-up).
3. Changing fail-closed uniqueness semantics for multi-match apply (RR-A).

---

## Key Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **`mergeAnchors` = planner expected ∪ description extract ∪ autoDetect(disk)** always (deduped, capped) | Ends preset divergence |
| D2 | **Auto-detect runs for large files always; for small files only if description yields anchors that miss** | Cheap; avoids noise on tiny files |
| D3 | **Window multi-match anchors by expanding context until unique or list all line #s** | Honest windows |
| D4 | **Not-found locus:** longest needle line that appears once, else max LCS/line-similarity score within file, else head | Better repair |
| D5 | **`end_not_found` ∈ repairable kinds** | Complete replace_between recovery |
| D6 | **Deterministic try of `uniqueCandidates[0]`** only if `SWARM_APPLY_DETERMINISTIC_CANDIDATE=1` and kind `*_not_found` | Opt-in; no silent multi-match |

---

## Proposed Design

### 1. `mergeAnchorsForTodo`

```typescript
// server/src/swarm/grounding/mergeAnchors.ts (new)

export function mergeAnchorsForTodo(opts: {
  todoDescription: string;
  expectedAnchors?: string[];
  fileTextByPath: Record<string, string>;
  maxAnchorsPerFile?: number; // default 8
}): Record<string, string[]> // file → anchors
```

Pipeline per expected file:

```text
anchors = uniq([
  ...expectedAnchors for file,
  ...extractAnchorsFromTodoDescription(desc),
  ...autoDetectAnchors(fileText, desc)  // when file large OR expected empty
]).slice(0, max)
```

### 2. Window uniqueness

Enhance `windowFileWithAnchors`:

```text
for each anchor:
  count = occurrences(file, anchor)
  if count === 1 → window ±R lines
  if count > 1 → expand anchor using expandToUnique; if still multi → inject:
    "ANCHOR multi-match at lines: L1, L2, ..." + first and last match excerpts
```

### 3. Not-found locus for `buildNearbyExcerpt`

When `focusOffset == null` and needle non-empty:

1. Split needle into lines; for each line with length ≥ 32, if `count===1`, use that offset.
2. Else score each file line by token Jaccard / shared prefix length vs longest needle line; take best above threshold.
3. Else file head (current behavior).

Expose as pure function tested with eee6718f-shaped fixtures.

### 4. Repairable kinds

```typescript
REPAIRABLE_APPLY_MISS_KINDS = [
  "search_not_found", "search_not_unique",
  "start_not_found", "start_not_unique",
  "end_not_found", // NEW
]
```

For `end_not_found`, candidates = unique headings/lines after start offset + expand start region.

### 5. Seed from `todo.lastApplyMiss`

When building worker prompt:

```text
if todo.lastApplyMiss within TTL (e.g. same run):
  inject block:
    PRIOR APPLY MISS (kind=..., candidates=...)
    Prefer these exact search/start strings.
```

### 6. `propose_hunks` tool

On apply failure:

```json
{
  "ok": false,
  "error": "<human message>",
  "miss": { ApplyMissReport fields }
}
```

Do not invent anchors; same pure apply path as production.

### 7. Optional deterministic candidate apply (RR-A core hook)

Inside `applyOrGroundedRepair` after first miss, **before** LLM:

```text
if env/flag && miss.kind in (search_not_found, start_not_found)
   && miss.uniqueCandidates[0] unique in file:
  rewrite hunk search/start to candidate[0]
  re-apply once
  if ok → note applied via deterministic_candidate; return
```

Default **off**.

---

## Alternatives considered

| Alternative | Why rejected |
|-------------|--------------|
| Always full file in prompt | Token cost / context thrash |
| Embedding-based locus v1 | Heavier deps; line Jaccard enough for v1 |
| Deterministic candidate always on | May apply wrong unique substring if candidates poor; opt-in |

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| More anchors → larger prompts | Cap anchors per file; keep window budget |
| Similarity locus false peak | Threshold + prefer exact line hits first |
| Deterministic candidate wrong apply | Default off; only not_found + unique |

---

## Success metrics

1. Council and blackboard produce identical anchor merge for same fixture todo+files (unit).
2. Multi-match anchors produce multi-match diagnostics, not silent first-only window.
3. Invented needle still yields non-head excerpt when a near line exists.
4. `propose_hunks` tests assert `miss.kind` present.
5. Live: fewer stage-1 misses before repair (measure via applyIntegrity).

---

## PR Plan

### PR 1: `mergeAnchorsForTodo` + wire council & blackboard

- **Files/components affected:** new `mergeAnchors.ts` (+ tests), `councilWorkerRunner.ts`, `workerTodoPrep.ts` / seed builders, replan seed if applicable
- **Dependencies:** RR-A complete preferred  
- **Description:** Unified anchor merge; delete divergent half-pipelines; unit fixtures for description + autoDetect.

### PR 2: Window multi-match honesty + not-found locus

- **Files/components affected:** `windowFile.ts` / `windowFileWithAnchors`, `applyMissReport.ts` (`buildNearbyExcerpt`), tests
- **Dependencies:** PR 1  
- **Description:** Multi-match line listing; similarity locus; panelRegistry-shaped fixtures.

### PR 3: `end_not_found` repairable + todo miss seed

- **Files/components affected:** `prompts/worker.ts` (`isRepairableApplyMiss`), candidate helpers, worker prompt seed, tests
- **Dependencies:** PR 2, RR-A miss persistence  
- **Description:** Repair kinds + candidates for end; inject lastApplyMiss into first-pass prompt.

### PR 4: `propose_hunks` miss payload + optional deterministic candidate

- **Files/components affected:** `ToolDispatcher.ts`, `applyOrGroundedRepair.ts`, env docs, tests
- **Dependencies:** PR 3  
- **Description:** Structured miss on tool fail; optional deterministic try behind flag.

---

## Acceptance checklist

- [ ] One mergeAnchors entrypoint  
- [ ] Multi-match window diagnostics  
- [ ] Not-found locus tests  
- [ ] end_not_found repair path  
- [ ] propose_hunks miss JSON  
- [ ] Deterministic candidate default off  

---

## Related

- RR-A recovery assumes better first-pass after this lands.  
- RR-C may inject catalog notes into same worker seed (orthogonal).  
