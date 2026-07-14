# Active work — queued + in-flight (across sessions)

> Persistent TODO list that survives between agent sessions.
> **Update it when you finish or queue work.**

---

## Release 1.0 (Tier A) — foundation + product/Brain expansion

See **`docs/RELEASE-1.0-PLAN.md`** and **`docs/BRAIN-OS-FOR-EXTERNAL-AGENTS.md`**.

- [x] Phases 0–7 foundation (security optional for single-user WIP)
- [x] Product: Simple vs Advanced presets; default blackboard; always `/runs/:id`
- [x] Reliability: pending-commit reaper; per-run stop debounce tests; outcome banner
- [x] Architecture: typed unified `createRunner`; V2 mid-flight phase prefer
- [x] Eval: preset-coverage gate across all modes; analysis tasks require rubric
- [x] Brain: control-surface API + CLI (say/drain/list/summary/control-surface)
- [ ] Optional: live Core scoreboard regen; split routes/swarm.ts further

---

## 2026-07-10 — Guards, quality levers, hygiene ✅ DONE

- [x] Empty-output / plan-empty / wall-clock / budget guards as primary loop gates
- [x] `guardNotify` → Brain inject + RECONFIG; `RunHealthChip` + `BrainSuggestionBubble`
- [x] Quality levers wired: failurePatternSeed, preserveDissent, selfCritique, swapSidesBiasCheck, pheromoneDecay, midCycleBroadcast
- [x] `spawnAgent` single API (drop `spawnAgentNoOpencode`)
- [x] Dead-code purge + `scripts/_dead-code-scan.mjs` / `_dead-code-report.md`
- [x] God-file modularization extracts (runners / routes / loops)

**Still library-only (schema accepted):** bestOfNTurn, dynamicRolePicker, mentionContracts.

**Wired:** `councilReconcile: "judge" | "vote"`; `preflightDryRun`; `hunkRag` (`.swarm-hunk-examples.jsonl` + worker few-shots).

---

## Queued: Run-start stability (P1)

See **`docs/plans/run-start-stability.md`** for full PR breakdown.

- [x] **PR1** — Unified `mergeTranscriptEntry` helper (hydrate + append dedup parity)
- [x] **PR2** — `SwarmStoreProvider` WS buffer + gate history fallback (fix false `stopped` phase)
- [x] **PR3** — `run-test --live-smoke` automated regression
- [x] **PR4** — Transcript virtualizer tuning (overscan/range + plain list under 50 entries)

---

## Done: Event log / Debug Log performance (P2) ✅

See **`docs/plans/event-log-performance.md`** for full PR breakdown.

- [x] List fast-path: per-run head/tail + stream scan, bounded archive gunzip, 45s cache
- [x] Topbar dropdown portals (tokens, runs, debug log)
- [x] **PR1** — `debug.meta.json` sidecar on run end
- [x] **PR2** — Paginated list API + `EventLogPanel` load-more
- [x] **PR3** — Persistent on-disk `event-log-index.json`
- [x] **PR4** — Rotated `debug-*.jsonl.gz` segment merge
- [x] **PR5** — Drill-down record pagination
- [x] **PR6** — Persistent archive index

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
