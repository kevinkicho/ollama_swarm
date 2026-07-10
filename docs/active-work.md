# Active work — queued + in-flight (across sessions)

> Persistent TODO list that survives between agent sessions.
> **Update it when you finish or queue work.**

---

## Release 1.0 (Tier A) — Phases 0–7 foundation landed 2026-07-09

See **`docs/RELEASE-1.0-PLAN.md`**.

- [x] **Phase 0** — Product freeze + maturity badges
- [x] **Phase 1** — Host security (bind, token, MCP, roots, SSRF, bash)
- [x] **Phase 2** — Crash/race hardening
- [x] **Phase 3** — Council quota ≠ audit-stuck
- [x] **Phase 4** — Partial V2 phase SoT on status
- [x] **Phase 5** — CI matrix ubuntu + windows
- [x] **Phase 6** — Eval score honesty
- [x] **Phase 7** — Brain approve-to-provision default
- [ ] Polish: full V2 cutover mid-flight; live Core eval table; apiFetch all routes

---

## Queued: Run-start stability (P1)

See **`docs/plans/run-start-stability.md`** for full PR breakdown.

- [x] **PR1** — Unified `mergeTranscriptEntry` helper (hydrate + append dedup parity)
- [x] **PR2** — `SwarmStoreProvider` WS buffer + gate history fallback (fix false `stopped` phase)
- [x] **PR3** — `run-test --live-smoke` automated regression
- [x] **PR4** — Transcript virtualizer tuning (overscan/range + plain list under 50 entries)

---

## Queued: Event log / Debug Log performance (P2)

See **`docs/plans/event-log-performance.md`** for full PR breakdown.

- [x] List fast-path: per-run head/tail + stream scan, bounded archive gunzip, 45s cache
- [x] Topbar dropdown portals (tokens, runs, debug log)
- [ ] **PR1** — `debug.meta.json` sidecar on run end
- [ ] **PR2** — Paginated list API + wire `EventLogPanel`
- [ ] **PR3** — Persistent on-disk `event-log-index.json`
- [ ] **PR4** — Rotated `debug-*.jsonl.gz` segment merge
- [ ] **PR5** — Drill-down record pagination
- [ ] **PR6** — Persistent archive index

---

## Queued: Project growth + knowledge graph (P2)

See **`docs/plans/project-growth-knowledge-graph.md`** for full PR breakdown.

- [x] **PR1** — Swarm evolution graph from run summaries (API + UI)
- [x] **PR2** — `.swarm/project-graph.json` sidecar + incremental merge
- [x] **PR3** — Agent context injection + recovery hints on drift
- [x] **PR4** — ConformanceMonitor v2 (anchor overlap + UI tooltip)
- [x] **PR5** — Git timeline layer (`git log` + UI toggle)
- [x] **PR6** — Import-based structure layer (opt-in env + UI)
- [x] **PR7** — Brain librarian graph queries

---

## Queued: Brain Implementation (see docs/ARCHITECTURE-VISION.md)

### P2: Wire LLM Analysis ✅ DONE
- [x] Call `prompt.ts` with real LLM in `brainOverseer.ts`
- [x] Create `BrainProposalsPanel.tsx` UI component
- [x] Add proposals state to Zustand store

### P3: Cross-Run Memory ✅ DONE
- [x] Read `current.jsonl` for real-time event patterns across runs
- [x] Read `logs/{runId}/summary.json` for per-run structured data
- [x] Persist proposals to `.swarm-improvements/proposals.jsonl`
- [x] Data pipeline for event logs and summaries

### P4: Brain Provisions Runs ✅ DONE
- [x] Brain generates RunConfig from proposals
- [x] Brain calls `orchestrator.start(cfg)`
- [x] Run provisioner created

### P5: Self-Upgrade — REMOVED
Brain no longer performs self-patching of the platform. Focus shifted to librarian/admin role for run records and analysis.

### P6: Brain-as-OS ✅ DONE
- [x] Brain service created
- [x] Brain wired to Orchestrator
- [x] Run health monitoring

### P7: System Wrapper UI ✅ DONE
- [x] P7.1: System status component
- [x] P7.2: Run queue component
- [x] P7.3: Brain panel enhancement
- [x] P7.4: Quick navigation
- [x] P7.6: Cross-run metrics
- [x] P7.7: Patch monitor
- [x] P7.8: Brain activity timeline
- [x] P7.6: Patch preview with diff display and debug controls

---

## Remaining Work

### P7.5: Layout Restructure — DONE
- [x] Create `SystemWrapper.tsx` — wraps entire app (wired in App.tsx)
- [x] Persistent sidebar with system/brain/nav

(Other items have been folded into STATUS.md active work or completed.)
