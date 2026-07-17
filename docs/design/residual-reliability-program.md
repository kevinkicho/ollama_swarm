# Residual Reliability Program (Post–eee6718f Grounding Stack)

| Field | Value |
|-------|-------|
| **Author** | Design program for post-grounding residual work |
| **Date** | 2026-07-17 |
| **Revision** | 1 |
| **Status** | Proposed — formal designs ready; **do not re-open shipped PR1–6** |
| **Related runs** | `eee6718f-03f3-45dd-a3a2-593076734102`, `9f449937-a060-49e6-9417-aba2774dfb16` |
| **Predecessor (shipped)** | [`eee6718f-grounding-and-research-resilience.md`](./eee6718f-grounding-and-research-resilience.md) (`1063fa7` + polish `09f704d`) |
| **Workflow** | Implement on **`main` only** (no multi-branch PR stacks unless user asks) |

---

## Overview

The grounding stack closed **disk-miss blindness**, **false literature thrash**, **stream balloons**, and **DDG-only dead ends for panel URLs**. Full-codebase scan after ship shows residual risk is now:

1. **Correctness edges** that can silently corrupt files (unsafe coerce, silent multi-match shorten, propose-after-failed-repair).
2. **Fragmented recovery** (council / blackboard / auditor / wrap-up each reinvent apply-repair with different quality).
3. **Research not local-first at runtime** for true literature / panel enrichment.
4. **Orchestration opacity** (cycle fails without buckets; wall “idle” without durable-progress truth).
5. **Incomplete stream/JSON finalization** off the council-worker happy path.

This program is an **index + dependency map** for five formal design documents. Each child doc has Goals, Key Decisions, Design, Risks, Metrics, and a **PR Plan** suitable for sequential implementation on `main`.

---

## Document map

| ID | Document | Scope | Priority |
|----|----------|--------|----------|
| **RR-0** | This file | Program index, non-goals, sequencing, success metrics | — |
| **RR-A** | [`apply-correctness-and-unified-recovery.md`](./apply-correctness-and-unified-recovery.md) | P0 correctness + unified apply/repair core | **Implement first** |
| **RR-B** | [`first-pass-grounding-and-midturn.md`](./first-pass-grounding-and-midturn.md) | Unified anchors, not-found locus, `end_not_found`, `propose_hunks` | After RR-A |
| **RR-C** | [`research-resilience-v2.md`](./research-resilience-v2.md) | Local-first, literature tools, adaptive backends, blackout parity, researchIntegrity | After RR-A; can parallel RR-B |
| **RR-D** | [`cycle-integrity-and-progress-heartbeat.md`](./cycle-integrity-and-progress-heartbeat.md) | cycleIntegrity buckets, empty-standup guard, progress heartbeat, live strip | After RR-A (metrics depend on recovery tags) |
| **RR-E** | [`finalize-deliberation-windows.md`](./finalize-deliberation-windows.md) | finalize everywhere, JSON sniff roles, deliberation structure, Windows rewrites | Parallel after RR-A |

```text
                    ┌──────── RR-A (correctness + unified recovery) ────────┐
                    │                                                       │
        ┌───────────┴───────────┬───────────────────┬───────────────────────┤
        ▼                       ▼                   ▼                       ▼
     RR-B                   RR-C                 RR-D                    RR-E
  first-pass            research v2          cycle + progress      finalize / host
  grounding             local-first          integrity             deliberation
```

**Rule:** RR-A lands before any path that assumes “never propose known-bad hunks” or stable `apply_path` tags for metrics.

---

## Already shipped (do not re-implement)

| Area | Location |
|------|----------|
| Stream loop abort / collapse / WS caps | `finalizeAgentOutput`, stream guards |
| Research policy preflight + hard search fail | `researchPolicy`, `webTools` |
| Strict `isLiteratureTodo` + council literature blackout | literature paths |
| Think-aware JSON `formatExpect` on workers | `jsonFormatSniff`, council/blackboard workers |
| `ApplyMissReport` + candidates + grounded repair prompt | `applyMissReport`, `buildHunkRepairPrompt` |
| Local catalog index + pluggable search adapters | `localCatalogIndex`, `searchAdapters` |
| `applyIntegrity` + run digest row | summary + `RunDigestModal` |
| Offline gate | `scripts/validate-grounding-stack.mjs` |

---

## Program goals

1. **No silent corrupt applies** (create-coerce, wrong multi-match shorten, wrap-up partial lies).
2. **One recovery quality bar** for every apply entrypoint.
3. **Local-first research** for panel/API work; free academic path when true literature is needed.
4. **Operator-visible why** cycles fail and whether the run is making durable progress.
5. **Measurable** via `applyIntegrity` + new `cycleIntegrity` / `researchIntegrity` + live chips.

## Program non-goals

1. Soft multi-match apply (first match wins) without explicit policy flag.
2. 0% cycle fail guarantee.
3. Paid search as default.
4. Full AST / diff3 patching.
5. Multi-branch Graphite stacks as the default workflow (prefer commits on `main`).

---

## Global success metrics (after live run + RR-A–D)

| Metric | Target |
|--------|--------|
| Silent half-file / wrong-occurrence applies | **0** known paths in unit tests + no production reports |
| `applyIntegrity`: unrepaired miss rate vs eee6718f | ≥50% drop on similar panel workloads (live) |
| Propose-after-failed-dry-run | **0** (blackboard) |
| Cycle fail attributable to apply vs json vs empty | Visible via `cycleIntegrity` buckets |
| Empty-standup consecutive cycles | Hard stop / reconfig after N (design default 3) |
| Literature thrash on non-research todos | Remain near zero (regression) |
| True research when needed | Catalog hit **or** usable backend without 10+ min thrash |

---

## Implementation notes

1. **Base branch:** `main`.
2. **Tests first** for correctness PRs (create-coerce, multi-match, propose-after-fail).
3. **Extend** `scripts/validate-grounding-stack.mjs` as suites land.
4. **Do not regress** literature blackout, fail-closed uniqueness for `replace_between`, emit-only repair profile.
5. After each phase: keep docs status Updated → Shipped with tip commit.

---

## Open program questions (defaults)

| Question | Default |
|----------|---------|
| Silent multi-match shorten for `replace` | **Fail-closed** (remove auto-apply); candidates only (RR-A) |
| Deterministic try of `uniqueCandidates[0]` | **Off by default**; opt-in env/flag (RR-B) |
| Empty-standup N | **3** consecutive empty execution cycles (RR-D) |
| Academic adapters | Free/keyless first (arXiv/OpenAlex); paid optional (RR-C) |
| Live progress quiet threshold | **4 minutes** no durable progress (RR-D) |

---

## Appendix: recommendation → design mapping

| # | Recommendation (scan) | Design |
|---|----------------------|--------|
| 1 | Unsafe create→replace 2KB coerce | RR-A |
| 2 | Silent multi-match replace shorten | RR-A |
| 3 | Blackboard propose after failed repair | RR-A |
| 4 | Wrap-up partial dry-run / fail-open | RR-A |
| 5 | Unified apply-or-grounded-repair core | RR-A |
| 6 | Unify first-pass anchors | RR-B |
| 7 | Persist ApplyMissReport on todo | RR-A / RR-B |
| 8 | `end_not_found` repairable | RR-B |
| 9 | Not-found locus / similarity | RR-B |
| 10 | Multi-match anchor windowing | RR-B |
| 11 | `propose_hunks` returns ApplyMissReport | RR-B |
| 12 | Deterministic candidate try (flag) | RR-B |
| 13–22 | Research v2 items | RR-C |
| 23–27 | Cycle integrity / progress / live strip | RR-D |
| 28–31 | Finalize / JSON sniff / deliberation / Windows | RR-E |
