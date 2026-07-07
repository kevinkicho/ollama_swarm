# Active work — queued + in-flight (across sessions)

> Persistent TODO list that survives between agent sessions.
> **Update it when you finish or queue work.**

---

## Queued: Run-start stability (P1)

See **`docs/plans/run-start-stability.md`** for full PR breakdown.

- [x] **PR1** — Unified `mergeTranscriptEntry` helper (hydrate + append dedup parity)
- [x] **PR2** — `SwarmStoreProvider` WS buffer + gate history fallback (fix false `stopped` phase)
- [x] **PR3** — `run-test --live-smoke` automated regression
- [x] **PR4** — Transcript virtualizer tuning (overscan/range + plain list under 50 entries)

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
