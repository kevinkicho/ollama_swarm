# Active work — queued + in-flight (across sessions)

> Persistent TODO list that survives between agent sessions.
> **Update it when you finish or queue work.**

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

### P5: Self-Upgrade ✅ DONE
- [x] `selfUpgrader.ts` — applies patches to own code
- [x] `brainQueue.ts` — system work serialized before project runs
- [x] Patch gating: only when ALL runs stopped

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

### P7.5: Layout Restructure (4-6 hr)
- [ ] Create `SystemWrapper.tsx` — wraps entire app
- [ ] Persistent sidebar with system/brain/nav
- [ ] Main content area for run-specific views
- [ ] Header shows system status

### Future Enhancements
- [ ] UpgradeMode.tsx — terminal-style upgrade UI
- [ ] Real-time brain monitoring (not just post-run)
- [ ] Brain self-upgrade with user approval flow
- [ ] Cross-run proposal deduplication
- [ ] System improvement scoring over time

---

## Done Recently

### 2026-07-01 — Brain Architecture + P7 System Wrapper
- P2-P6: Brain as OS implementation
- P7.1-P7.8: System wrapper UI components
- Architecture vision documented in `docs/ARCHITECTURE-VISION.md`

### 2026-07-01 — Fixes
- Auditor-gated commit system
- History tab/dropdown fixes
- Concurrent run support
- XML tool-call leak fix
- TodoQueue.fail idempotency
- Hunk-repair regex fix

### 2026-06-30 — UI Improvements
- Cohesive UI theme (glow animations, fade-in)
- Agent-0 (brain) styling
- Streaming transcript persistence
- Worker context files
- Auto-anchor for large files
- Planner thinking visibility
- Planning tab
