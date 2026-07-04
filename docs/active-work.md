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
- [x] Main content area for run-specific views
- [x] Header shows system status + recent topbar/layout hardening

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

### Recent (post-2026-07-01) — Proxy/Gateway hardening, Brain UX, Observability, Dynamic scaling
- Aggressive proxy hardening: incremental streaming (bounded buffer, no full-body), runId header propagation (X-Swarm-Run-Id), bounded records + pressure(), improved quota for Cloud 503s.
- ProviderGateway: bounded queues (64), drop low-pri with rejection, brainInitiated priority (5 vs 0), pressure integration.
- Brain provisioning: dynamic agentCount (8 low-pressure / 4 high, for max stability/efficiency — no token limits), pressure check in provisioner.
- Proposal apply UX: suggestedHunks in ImprovementProposal + LLM parser, default to suggested on apply, richer diff preview in BrainProposalsPanel (unified diff style).
- UI: proxyPressure in SystemStatusPanel + /api/usage + /brain/health; brain badges + per-run metrics; simple upgrades history in BrainActivityPanel; richer previews.
- Self-upgrader visibility: more detail in patch activities (commit SHA); upgrade history UI.
- No token usage concerns: relaxed agent limits / model choices in Brain paths; use as many agents as needed for stability/efficiency.
- Dynamic agentCount: 8 (low pressure) / 4 (high) based on proxy pressure for max efficiency/stability.
- Richer diff previews: unified diff-style in BrainProposalsPanel with search/replace snippets.
- History panel: Recent Upgrades section in BrainActivityPanel from patch activities.
- Brain-OS management layer iteration: added startBackgroundMonitoring() + ticker in BrainService (real-time health ticks every 60s, pressure-aware). Wired in Orchestrator so it runs continuously. Emits brain_health_tick events.
- Docs: updated active-work.md, STATUS.md, etc.
- Tests/build: proxy runId/bounded tests, build clean (tsc), brain/proxy tests pass (18/18 proxy, brainService ok). Full verification passed.
