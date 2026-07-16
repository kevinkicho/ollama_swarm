# Worker Grounding, Anchor Apply, and Research Resilience

| Field | Value |
|-------|-------|
| **Author** | Design for postmortem follow-through |
| **Date** | 2026-07-16 |
| **Revision** | 2 |
| **Status** | Proposed — ready for `/execute-plan` (PR Plan labels normalized) |
| **Related runs** | `eee6718f-03f3-45dd-a3a2-593076734102`, `9f449937-a060-49e6-9417-aba2774dfb16` |
| **Related code** | `applyHunks.ts`, `windowFile.ts`, `autoAnchor.ts`, `worker.ts` prompts, `webTools.ts`, `researchPolicy.ts`, `councilWorkerRunner.ts`, `buildHunkRepairPrompt` |
| **Already shipped (do not re-do)** | Stream loop abort/collapse, finalizeAgentOutput, research policy gate, literature false-positive fix (`isLiteratureTodo`), literature blackout/cache, think-aware `formatExpect` JSON sniff |

---

## Overview

Runs `9f449937` and `eee6718f` closed the **stream balloon** and **false literature thrash** classes. Remaining permanent / high-cost worker failures are **disk-grounded** and **research-backend** problems:

1. **Search-anchor misses** — `op:"replace"` / `replace_between` with `search`/`start` text not present in the live file (stale prompt excerpt or invented anchors).
2. **Non-unique `replace_between` / `replace`** — `start` or `search` matches 2+ times; apply fails closed (correct) but recovery is weak.
3. **True literature still broken when needed** — DDG HTML 403; blackout correctly stops thrash, but there is no alternate free backend and no strong **local-first API catalog** path for panel/endpoint work.

This design turns those into **incremental, reviewable PRs** with clear ownership, tests, and success metrics — not more detectors that only log the same failure.

---

## Background & Motivation (verified)

### Run `eee6718f` (council, 3 agents, ~36 min, user stop)

| Signal | Count / value |
|--------|----------------|
| Files changed | 48 |
| ✓ applied commits | 47 |
| Literature tool-loop fails | ~20 (mostly false-positive todos — **fixed in `5248497`**) |
| Primary JSON parse (`<think>…`) | 12 (**format sniff wired in `5248497`**) |
| Search not found / non-unique | ~4 hard apply fails in transcript |
| Cycle fail rates | 36% → 35% → 19% → 20% (improves as files stabilize) |
| Peak agent text | ~8.7k (stream integrity OK) |

### Failure classes still open after `5248497`

```text
PRIMARY FAIL BUCKETS (eee6718f, remaining after shipped fixes)
├── search_not_found / start_not_found     ← PR-A, PR-B
├── start/search matches N times           ← PR-B
├── worker returned no hunks               ← partially helped by format sniff; PR-A improves prompts
└── true literature when needed + DDG 403  ← PR-C, PR-D
```

### Existing partial infrastructure

| Piece | Gap |
|-------|-----|
| `windowFileWithAnchors` + `extractAnchorsFromTodoDescription` | Anchors often missing or wrong; miss report not fed into repair |
| `applyHunks` trailing-whitespace normalize + suffix unique-shorten for `replace` | **`replace_between` has no multi-match recovery**; no fuzzy whitespace for `start` |
| `buildHunkRepairPrompt` | Called on search miss, but often re-prompts without re-reading file or suggesting unique substrings |
| `researchPolicy` + literature blackout | Stops thrash; does not provide **working** search or local catalog when research is legitimate |
| `GOVERNMENT_API_CATALOG.md` / `docs/API_ENDPOINTS.md` seed | Present for planner; **not injected into literature fail / worker repair paths** |

---

## Goals & Non-Goals

### Goals

1. **Raise apply success rate** on replace / replace_between without weakening fail-closed safety (no multi-match silent apply).
2. **Ground every repair** on a **fresh disk read** + structured miss report (nearby lines, unique candidate anchors).
3. **Local-first research path** for panel/endpoint todos when web search is down or blacked out.
4. **Pluggable search backends** for true literature (no single DDG dependency).
5. **Measurable** via transcript reason buckets + optional `streamIntegrity`-style summary field for apply/repair stats.

### Non-Goals

1. Guaranteeing 0% cycle fail rate (model will still invent bad hunks).
2. Paid search APIs as the default (optional env keys only).
3. Full fuzzy diff3 / AST patching (out of scope for v1; exact-string hunks remain).
4. Re-opening stream-loop / formatExpect work already on `main`.

---

## Key Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Structured `ApplyMissReport` at apply time** | Callers (council, wrap-up, blackboard) share one repair payload; no more free-text-only reasons. |
| D2 | **`replace_between` uniqueness = start unique in file; end first-after-start** | Matches current semantics; recovery expands `start` with surrounding lines rather than picking arbitrary match. |
| D3 | **One disk re-read + deterministic candidate anchors before LLM repair** | Cheap; prevents repair prompts that re-use stale windowed excerpts. |
| D4 | **Research = local catalog first, web second** | Panel work almost never needs DDG; official URLs live in repo docs. |
| D5 | **Search backends as ordered adapters** | DDG HTML → DDG lite (already) → optional Brave/Serper/Bing if key → **local endpoint index** always available. |
| D6 | **PR stack is bottom-up: types/report → apply → repair wiring → research** | Repair UI/prompts depend on ApplyMissReport; research is independent after PR-A groundwork. |

---

## Proposed Design

### A. Apply miss report (shared contract)

```typescript
// shared or server/src/swarm/blackboard/applyMissReport.ts
export type ApplyMissKind =
  | "search_not_found"
  | "search_not_unique"
  | "start_not_found"
  | "start_not_unique"
  | "end_not_found"
  | "other";

export interface ApplyMissReport {
  file: string;
  hunkIndex: number;
  op: string;
  kind: ApplyMissKind;
  /** Snippet model used (truncated). */
  needle: string;
  matchCount: number;
  /** ±N lines around best guess / first match / file head. */
  nearbyExcerpt: string;
  /** Deterministic unique substrings of needle that appear once in file (if any). */
  uniqueCandidates: string[];
  /** Human one-liner for transcript (compatible with today's messages). */
  message: string;
}
```

`applyFileHunks` / `applyHunks` either:

- **Option 1 (preferred):** return `{ ok: false, error: string, miss?: ApplyMissReport }` (back-compat: `error` stays parseable; `miss` is additive), or  
- **Option 2:** keep string error; add `parseApplyError(error, fileText) → ApplyMissReport | null` pure helper used by repair.

**Chosen: Option 1** — miss data at source is more accurate (counts, candidates computed while file is in hand).

### B. Anchor grounding pipeline (before emit + on repair)

```mermaid
flowchart TD
  Todo[Todo description + expectedFiles] --> Anchors[Merge expectedAnchors + extractAnchorsFromTodoDescription + autoAnchor]
  Anchors --> Read[Fresh readExpectedFiles]
  Read --> Window[windowFileWithAnchors or full if under threshold]
  Window --> Prompt[Worker prompt]
  Prompt --> Hunks[Model hunks]
  Hunks --> Apply[applyHunks with miss reports]
  Apply -->|ok| Commit[Commit]
  Apply -->|miss| Report[ApplyMissReport]
  Report --> Reread[Re-read file]
  Reread --> Candidates[uniqueCandidates + nearbyExcerpt]
  Candidates --> RepairPrompt[buildHunkRepairPrompt v2]
  RepairPrompt --> Hunks
```

**Improvements vs today**

1. **Always re-read** before repair (council already re-reads in `tryWorkerPrompt`; ensure repair path uses **miss.nearbyExcerpt from post-fail file**, not pre-prompt window only).
2. **Candidate generation (deterministic, no LLM):**
   - For `search_not_found`: longest line prefixes/suffixes of needle that appear exactly once (extend existing `replace` multi-match shortening to **not-found** case: try unique **sublines**).
   - For `start_not_unique`: expand `start` by adding N lines of file context above/below first match until unique (max N=5); if still not unique, list line numbers of all matches in report.
3. **`replace_between` parity:** apply same trailing-trim normalize on `start` / `endExclusive` as `replace` does for `search`.

### C. Research resilience

```mermaid
flowchart LR
  Need[Research needed] --> Local{Local catalog hit?}
  Local -->|yes| Notes[Inject catalog + API_ENDPOINTS excerpts]
  Local -->|no| Blackout{researchBlackout?}
  Blackout -->|yes| Notes
  Blackout -->|no| Backends[Ordered search adapters]
  Backends --> DDG[DDG HTML]
  Backends --> Lite[DDG lite]
  Backends --> Keyed[Optional env API key backends]
  Backends --> Fail[Soft fail + local notes only]
```

**Local catalog index (PR-D)**

- Build a tiny in-memory index at run start (or lazy): scan `docs/API_ENDPOINTS.md`, `GOVERNMENT_API_CATALOG.md`, `docs/PANELS.md` for URLs and route names.
- On literature trigger **or** blackout: inject top-K snippets matching todo keywords (FRED, BIS, OECD, etc.).
- This is the primary path for **panel work**; web is optional enrichment.

**Search adapters (PR-C)**

- Interface: `SearchAdapter { id; search(query): Promise<SearchLink[]> }`
- Registry order: existing DDG HTML, DDG lite, then if `BRAVE_API_KEY` / `SERPER_API_KEY` / `BING_SEARCH_KEY` set, use that.
- No new paid dependency required for merge; keys optional.
- Rate-limit and fail-closed to local catalog after N adapter failures (align with blackout).

### D. Observability

Add optional `applyIntegrity` on run summary (mirror `streamIntegrity`):

```typescript
applyIntegrity?: {
  attempts: number;
  applied: number;
  missByKind: Record<string, number>;
  repairSuccesses: number;
  repairFailures: number;
};
```

Populate from council + blackboard apply paths via a small counter on adapter state / runner.

---

## Alternatives considered

| Alternative | Why rejected |
|-------------|--------------|
| Always full-file in worker prompt | Token blow-up on large files; already have anchors |
| Soft multi-match apply (first match wins) | Silent wrong edit risk |
| Only more detectors / stuck messages | Already solved thrash; need successful apply/research |
| Require paid search | Breaks free/default product |

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Candidate substrings too short → wrong unique match | Min length 20–40 chars; prefer multi-line candidates |
| `ApplyMissReport` breaks string-only callers | Keep `error` string; `miss` optional |
| Catalog index stale | Rebuild each run from clone disk |
| format sniff + ollamaFormat double-abort | Already separate; this plan does not change sniff thresholds |

---

## Success metrics (post-merge runs)

1. **Search not found** primary fails drop ≥50% vs eee6718f baseline on similar panel workloads.
2. **Literature messages** only appear for explicit research todos; blackout rare.
3. When web down, worker prompts still contain **at least one** catalog URL/snippet for gov/panel todos.
4. Unit tests for apply miss kinds + candidate generation; adapter tests with mocked fetch.

---

## Open Questions (resolved defaults)

| Question | Default for implementation |
|----------|----------------------------|
| Paid search required? | No — optional env only |
| Min unique candidate length | 32 chars |
| Repair max re-tries | Keep existing stage 2 + 3; improve payload quality only |
| Catalog files | `docs/API_ENDPOINTS.md`, `GOVERNMENT_API_CATALOG.md`, `docs/PANELS.md` if present |

---

## Full postmortem inventory → execution status

Everything raised across **9f449937** and **eee6718f** postmortems, mapped so nothing open is “detector-only.”

| # | Postmortem item | Origin | Status | Execution plan |
|---|-----------------|--------|--------|----------------|
| 1 | ~300k stream balloon / final-text repetition | 9f449937 | **Shipped** | Stream guards, abort, collapse, WS/event caps |
| 2 | DeepSeek `<function><name>…` raw in UI | 9f449937 | **Shipped** | `extractToolCallMarkers` shapes + display |
| 3 | ```json fence / deliverable summary polish | 9f449937 | **Shipped** | tryPrettyJson + deliverable system path |
| 4 | extractActionableTodos abort soft-empty | 9f449937 | **Shipped** | Longer timeout + clearer abort |
| 5 | Placeholder `your-org` / `file://` web_fetch | 9f449937 | **Shipped** | `researchPolicy` preflight + webTools refuse |
| 6 | Literature thrash / false `isLiteratureTodo` | eee6718f | **Shipped** | Strict research language + blackout/cache (`5248497`) |
| 7 | Think-only JSON parse (formatExpect dead on Ollama) | eee6718f | **Shipped** | Think-aware JSON sniff wired (`5248497`) |
| 8 | Research tool-loop stuck / fail streak | both | **Shipped** | researchPolicy + hard search fail + fail streak |
| 9 | streamIntegrity summary + UI ribbon | both | **Shipped** | `e661536` |
| 10 | **Real search-anchor misses** (`search`/`start` not in file) | both | **OPEN** | **PR 1–3** (report + candidates + grounded repair) |
| 11 | **Non-unique `replace_between` / `replace`** | eee6718f | **OPEN** | **PR 1–2** (normalize + expand-to-unique) |
| 12 | Wrap-up synthesizer 16→0 (stale anchors) | 9f449937 | **Partial** | Fallthrough exists; **PR 3** feeds ApplyMissReport + candidates |
| 13 | **DDG 403 when true literature needed** | both | **OPEN** | **PR 4–5** (local catalog first, then pluggable backends) |
| 14 | Cycle fail 20–36% (apply-dominated residual) | eee6718f | **OPEN metric** | Improves via PR 1–3; **PR 6** measures |
| 15 | Wall-clock idle / no progress UI | eee6718f | **N/A here** | Observability only; not a code bug in this stack |

**Hard problems that must not be “fixed away” with another detector (user guidance):**

1. Real search-anchor misses → better **local file grounding** on repair (PR 1–3).  
2. Unique `replace_between` → deterministic uniqueness recovery, still fail-closed (PR 1–2).  
3. DDG 403 when true literature is needed → **local catalog + alternate search backends**, not more blackout-only (PR 4–5).

---

## PR Plan

Dependency order (linear stack for plain-git / Graphite):

```text
PR1 ──► PR2 ──► PR3 ──► PR6
                │
PR4 ──► PR5 ────┘   (PR4 can start after PR1 conceptually; stack order: PR1→PR2→PR3→PR4→PR5→PR6)
```

Linearized for `/execute-plan`: **PR1 → PR2 → PR3 → PR4 → PR5 → PR6**.

### PR 1: Structured apply miss reports and replace_between normalize

- **Files/components affected:** `server/src/swarm/blackboard/applyHunks.ts`, `server/src/swarm/blackboard/applyMissReport.ts`, `server/src/swarm/blackboard/applyHunks.test.ts`, `server/src/swarm/blackboard/applyMissReport.test.ts`
- **Dependencies:** None
- **Description:** Add structured `ApplyMissReport` on apply failure (`kind`, `needle`, `matchCount`, `nearbyExcerpt`, `uniqueCandidates`, human `message`/`error`). Port trailing-whitespace / CRLF normalize from `replace.search` to `replace_between.start` and `endExclusive`. Keep fail-closed multi-match semantics. Unit tests: not found, not unique, normalize parity; success path unchanged.

### PR 2: Unique substring and expand-start candidates for repair

- **Files/components affected:** `server/src/swarm/blackboard/applyMissReport.ts`, `server/src/swarm/blackboard/applyMissReport.test.ts`, `server/src/swarm/blackboard/applyHunks.ts`
- **Dependencies:** PR 1
- **Description:** Pure helpers `findUniqueSubstrings(needle, fileText)` (min length 32) and `expandToUnique(start, fileText, maxExpandLines=5)`. Populate `uniqueCandidates` for `search_not_found` / `start_not_unique`. Fixtures shaped like eee6718f `panelRegistry` multi-section keys. No silent first-match apply.

### PR 3: Grounded hunk repair for council, blackboard, and wrap-up

- **Files/components affected:** `server/src/swarm/blackboard/prompts/worker.ts`, `server/src/swarm/councilWorkerRunner.ts`, `server/src/swarm/blackboard/workerRunner.ts`, `server/src/swarm/wrapUpApplyPhase.ts`, related tests
- **Dependencies:** PR 1, PR 2
- **Description:** `buildHunkRepairPrompt` v2 includes failed op, needle, **fresh-disk** nearby excerpt, and unique candidate `search`/`start` suggestions. Wire on council worker apply miss, blackboard repair path, and wrap-up synthesizer total-miss fallthrough (9f449937 16→0). Never re-enter literature research on pure apply repair. Optional `[apply-miss]` system line with kind.

### PR 4: Local endpoint catalog index for worker grounding

- **Files/components affected:** `server/src/swarm/research/localCatalogIndex.ts`, `server/src/swarm/research/localCatalogIndex.test.ts`, `server/src/swarm/councilWorkerRunner.ts`, `server/src/swarm/blackboard/workerLiteratureResearch.ts`, optional worker/planner prompt inject sites
- **Dependencies:** PR 3
- **Description:** In-memory index of clone docs (`docs/API_ENDPOINTS.md`, `GOVERNMENT_API_CATALOG.md`, `docs/PANELS.md` if present). `lookupLocalCatalog(todoDescription, maxSnippets) → string`. Inject on literature blackout / hard search fail and for panel-ish todos so workers keep real gov URLs without DDG. Zero network.

### PR 5: Pluggable web_search adapters beyond DDG

- **Files/components affected:** `server/src/tools/webTools.ts`, `server/src/tools/searchAdapters.ts`, `server/src/tools/searchAdapters.test.ts`, `docs/AGENT-GUIDE.md` (or env example), `server/src/tools/researchPolicy.ts` (docs only if needed)
- **Dependencies:** PR 4
- **Description:** `SearchAdapter` interface + ordered registry: DDG HTML → DDG lite → optional `BRAVE_API_KEY` / `SERPER_API_KEY` / `BING_SEARCH_KEY`. After adapter exhaustion, soft-fail with **local catalog notes** from PR 4 (never invent links). Shared rate limit; blackout-compatible errors. Default free path unchanged when no keys.

### PR 6: applyIntegrity stats on run summary

- **Files/components affected:** summary types (`summaryTypes` / discussion summary builders), council/blackboard apply counters, optional web digest UI
- **Dependencies:** PR 3
- **Description:** Add optional `applyIntegrity: { attempts, applied, missByKind, repairSuccesses, repairFailures }` on run summary (mirror `streamIntegrity`). Populate from apply + repair paths. Enables measuring ≥50% drop in search-not-found primary fails vs eee6718f baseline.

---

## Implementation notes for `/execute-plan`

1. **Base branch:** `main` (includes stream integrity + literature fix + format sniff).
2. **Do not regress:** literature blackout, `isLiteratureTodo` strictness, `finalizeAgentOutput`, research policy preflight, placeholder URL blocks.
3. **Test priority:** pure apply/helpers first (PR1–2), then wiring (PR3), then research (PR4–5), then metrics (PR6).
4. **Fixtures:** use strings from eee6718f-style errors:
   - `panelRegistry.js` multi-section keys
   - `marketPanels.js` replace miss
   - COMMERCIAL_PAPER naming (must not trigger literature)
5. **Invoke:**  
   `/execute-plan docs/design/eee6718f-grounding-and-research-resilience.md`  
   Optional: `--dry-run` first; `--concurrency 2` if machine is busy; `--auto-pr` if plain-git + `gh`.

---

## Out of scope reminders (already shipped — do not re-implement)

| Item | Commit / area |
|------|----------------|
| Stream loop abort / WS / event-log caps | `1cec711` et al. |
| finalizeAgentOutput + research policy | `6efa8ef` |
| Literature false positives + blackout + JSON sniff | `5248497` |
| streamIntegrity on summary + UI ribbon | `e661536` |
| DeepSeek function strip / placeholder URL refuse | 9f449937 fix stack |
| Wrap-up fallthrough re-prompt (basic) | partial; upgraded by PR 3 |

---

## Acceptance checklist for the stack

- [ ] PR1–2: apply tests for miss kinds + candidates; replace_between normalize parity  
- [ ] PR3: repair prompt grounded on council + blackboard + wrap-up; no literature re-entry on repair  
- [ ] PR4: local catalog injection when web blackout / hard search fail  
- [ ] PR5: optional adapters; default free path works; never invent results  
- [ ] PR6: summary.json includes missByKind after apply activity  
- [ ] Manual: re-run panel-heavy council directive; literature noise near zero; apply miss rate down; true research still possible with key **or** catalog  

---

## Appendix: evidence map (transcript → PR)

| Transcript pattern | Design PR |
|--------------------|-----------|
| `search text not found` / `start text not found` | PR 1–3 |
| `start text matches 2 times` / `search text matches N times` | PR 1–2 |
| Wrap-up: N hunks → 0 applied (stale anchors) | PR 3 |
| `tool loop stuck: research` on panel todos | Shipped (`isLiteratureTodo`); PR 4 when research is real |
| DDG 403 / backends unavailable | PR 4 + PR 5 |
| `JSON parse failed: <think>` | Shipped (format sniff) |
| Cycle 30% fail early, 20% late | Expected improvement from PR 1–3; measure with PR 6 |
