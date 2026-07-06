# Project status — what's true right now

**Last updated:** 2026-07-05 (Phase 9/10: COMPLETE removal of hybrid mode; all hybrid references, fields, UI, and orchestration logic removed from the app. Use "pipeline" preset for chaining or pure presets.)
**Purpose:** single short doc you read first to understand current state without trawling through changelog or stale function references. If this doc disagrees with code, code wins — file an issue against this doc.

> **2026-04-29 — opencode subprocess removed (E3 Phases 1–5).** Every prompt
> now goes through a direct `SessionProvider` (Ollama / Anthropic / OpenAI)
> via `chatOnce`. Tool-using turns route through an in-process `ToolDispatcher`
> (read/grep/glob/list/bash with a hard allowlist). `Agent.client`, the
> `@opencode-ai/sdk` dep, the `PortAllocator`, and the spawn-subprocess code
> path are all gone. `OPENCODE_SERVER_PASSWORD` is still required at
> config-load time so existing `npm test` setups don't break, but it's
> otherwise unused.
>
> **2026-07 — Legacy agent memory consolidated:** `.opencode/session-checkpoint.md` (and `.opencode/`) superseded and removed after consolidation of historical notes (council refactor, test snapshots, old LOCs) into `docs/STATUS.md`, `docs/AGENT-GUIDE.md`, and `README.md`. `opencode.json` now points at current docs. Old `terminals/*.txt` are runtime logs (not guidance).

---

## What ships today (high level)

The app is a **Brain-as-OS for concurrent swarm orchestration**:

- **Brain-as-OS layer** (under blackboard): real-time monitoring, run analysis & final reports, cross-run knowledge (librarian), run provisioning, health tracking. Brain acts as master-admin for initializing, starting, finishing, reviewing records and analyzing runs. Self-upgrader is present in *safe recording mode only* (logs system/prompt improvement proposals from insights into `logs/upgrades.jsonl`; never auto-applies platform patches — manual git review required). See `brainOverseer/selfUpgrader.ts` + wiring in `runBrainAnalysis`.
- **Brain during live runs (FAB + chat + suggest)**: Floating fixed 🧠 "Brain" pill (bottom-right in SystemWrapper, shown for active runs) opens modal running `BrainStartChat` with runContext (transcript summary via formatServerSummary + board todos + phase + cfg). Chat uses `/brain/chat` (with runContext prompt augmentation). History saved per-run via store + `/brain/chat-history` + RunStatePersister + summary recovery. `/brain/suggest` calls `brainService.injectSuggestion` which appends system + emits `brain_suggestion` transcript kind (rendered in MessageBubble). Proactive inject wired in Council stuck cycles + adaptive watchdog stalls.
- **Concurrent multi-swarm support**: multiple independent runs in parallel (`/runs/:runId` routing, ActiveRunsPanel, per-run WebSocket/REST, concurrency cap). Brain and UI manage them at system level.
- **System UI**: `SystemWrapper` with persistent sidebar, floating Brain FAB, BrainProposalsPanel, BrainActivityPanel, SystemStatus, PatchMonitor, RunQueue, topbar stats/health. Transcript defaults to full "all" view (normal unfiltered log of everything). Optional "key"/other filters available in the bar to reduce noise if desired.
- **Recent major UI work**: full viewport layout hardening, sticky elements, scrolling fixes; dedicated Brain chat + suggest flow. 
  - Hybrid mode fully removed (no more special orchestration, fields, or UI). Composite chaining available via the explicit "pipeline" preset.
  - Windows dev: `npm run dev` Ctrl+C now reliable (readline fallback for npm/PowerShell, sync taskkill, explicit kill-port on 8243/8244).
  - Transcript: virtual list now reliably draws all items (rangeExtractor with scroll+tail, mounted force-measure, tuned estimates + ITEM_GAP_PX=6).
- **12 presets** with the existing write-mode story (blackboard native writes; others opt-in via `writeMode`).

**12 swarm presets** (blackboard + 10 discussion/pipeline variants + baseline). Opt-in write capability for discussion presets:

| Preset | Maturity | Write-capable? | Notes |
|---|---|---|---|
| `blackboard` | production | ✅ (native) | planner + workers + auditor; tier ratchet; Aider-style hunks; pre-commit verify gate (`verifyCommand`). Most tested preset with deepest maturity. |
| `round-robin` | production | ⚡ (opt-in) | Rotating Critic/Synthesizer/Gap-finder/Builder dispositions framed around directive. `cfg.writeMode: "single"` → synthesizer produces hunks; `"multi"` → vote reconciliation. |
| `council` | production | ✅ (native) | **3-phase autonomous cycle:** Phase 1 (Analysis): N agents debate and synthesize consensus. Phase 2 (Execution): ALL agents become workers, produce hunks via pipeline. Phase 3 (Audit): ALL agents inspect changes. Cycles repeat in autonomous mode (`rounds: 0`). Retry-on-failure with error feedback. **Architecture:** `CouncilRunner.ts` orchestrates; `councilDecisions.ts` handles todo extraction (`extractActionableTodos`, `extractTodosFromAudit`) with path grounding — legacy Gate 1/3/4 decision helpers were removed. `councilExecution.ts` handles parallel worker execution; `councilAudit.ts` handles audit phase; `councilSynthesis.ts` handles synthesis; `councilDeliverable.ts` handles deliverables; `councilVoteReconcile.ts` handles vote reconciliation. **Blackboard infrastructure:** Uses TodoQueue, ExitContract, hunk-based editing, replanner, path grounding, and tier ratchet. |
| `orchestrator-worker` (flat) | production | ⚡ (opt-in) | Lead decomposes directive into subtasks for workers. Phase 1: lead synthesis; Phase 2: sequential reconciliation (CAS on file hashes). |
| `role-diff` | beta | ⚡ (opt-in) | Specialist role assignment per agent with diff-based deliverable. Phase 1: specialist synthesis; Phase 2: vote reconciliation. |
| `debate-judge` | beta | ⚡ (opt-in) | PRO/CON/JUDGE debate structure. Phase 1: judge verdict produces hunks; Phase 2: judge picks winner's hunks. |
| `map-reduce` | beta | ⚡ (opt-in) | Mappers find directive-relevant evidence → reducer synthesizes. Phase 1: reducer hunks; Phase 2: merge reconciliation (isolated slices). Partition-dependent quality. |
| `orchestrator-worker-deep` | needs-validation | ⚡ (opt-in) | 3-tier: orchestrator → mid-leads → workers. Phase 1: multi-tier synthesis; Phase 2: sequential reconciliation. **Known issue:** validation tour hit model-drift failures — some models produce XML pseudo-tool-calls under structured-output pressure in deep chains. |
| `stigmergy` | exploration | ❌ | Pheromone-table + per-file annotations. **Read-only by design** — exploration mode, no write pipeline. Pheromone heatmap feeds blackboard workers when `cfg.stigmergyOnBlackboard` is on. |
| `moa` | beta | ⚡ (opt-in) | Mixture of Agents: proposers → aggregators, three layers of depth. Phase 1: aggregator hunks; Phase 2: aggregator picks best proposer's hunks. **Shipped 2026-05-01 in a single day; less polish than older presets.** |
| `baseline` | production | ✅ (native) | single agent / single prompt / single apply step — eval-harness path, not in the form's normal preset list |
| `pipeline` | beta | ⚡ (opt-in) | Chains sub-runs with transcript/deliverable piping. Default phases: Explore → Decompose → Validate. Each phase's output feeds the next. |

All presets honor the user directive except `stigmergy` (exploration is repo-driven by design).

**Research / internet-heavy use cases**: Prefer `webTools: true` + `plannerTools: true` with council, map-reduce, moa, role-diff, or pipeline (for chaining analysis → execution). See README.md and the preset matrix for recommended combinations.

**Legend:** ✅ native write support | ⚡ opt-in via `cfg.writeMode: "single" | "multi"` + `cfg.writeModel` | ❌ no write support

Validation: tour v2 (2026-04-28) ran 9 sequentially with 8/9 self-terminating cleanly. MoA shipped 2026-05-01 with three layers of depth (initial → convergence detection → heterogeneous models per layer). Blackboard caps tightened by #304 (git committer identity) + #305 (cap watchdog 5s tick).

---

## Observability + reliability stack (2026-04-28)

| Feature | What it does | Code |
|---|---|---|
| Conformance gauge | LLM-as-judge polls every 90s; sparkline + numeric score in topbar | `server/src/services/ConformanceMonitor.ts` |
| Embedding drift gauge | Independent cosine-similarity signal; agreement hint vs LLM-judge | `server/src/services/EmbeddingDriftMonitor.ts` |
| Mid-run amend | User submits directive addendum; planner picks up at next cycle | `server/src/services/AmendmentsBuffer.ts` + `/api/swarm/amend` |
| Cost-share breakdown | Per-agent token shares + savings hint in run summary | `web/src/lib/costBreakdown.ts` |
| Eval harness | preset×task scoreboard | `eval/run-eval.mjs` + `eval/catalog.json` |
| Pre-commit verify gate | Worker hunks gated by user shell command (npm test, lint, etc.) | `WorkerPipeline.VerifyAdapter` |
| HITL nudge channel | `/api/swarm/amend` + topbar textarea | `IdentityStrip.AmendButton` |
| Brain-as-OS | proposals, analysis, run provisioning, health monitoring, during-run chat (FAB), proactive suggestions via injectSuggestion | `brainOverseer/*`, `brainService.ts`, `/brain/*` routes, SystemWrapper + BrainStartChat + transcript MessageBubble (brain_suggestion kind) |
| Concurrent runs + Active Runs UI | multi-tenant, per-run routing, ActiveRunsPanel | Orchestrator + `/api/swarm/active-runs` + deep links |
| V2 event log | `/api/v2/event-log/runs` + UI EventLogPanel; infra-only filter | `EventLogReaderV2` |
| Run history (95+ runs) | History dropdown auto-scans `runs*/` at startup | `Orchestrator.scanForRunParents` |
| Model autocomplete | `/api/models` proxies Ollama tags into datalist on every model field | `useAvailableModels` hook |
| Agent tools | Local-only (read/grep/glob/list + restricted bash). No web/internet tools for agents. | `ToolDispatcher`, profiles in `promptWithRetry` / `roles.ts` |
| Cap watchdog (5s tick) | Wall-clock + commits + todos caps fire promptly during any phase | `BlackboardRunner.startCapWatchdog` (#305) |
| `runs/` retention | `node scripts/prune-runs.mjs --apply` keeps last N + last 7 days | `scripts/prune-runs.mjs` |
| `logs/` retention | `node scripts/prune-logs.mjs --apply` (current.jsonl rotations + per-run debug*.jsonl) | `scripts/prune-logs.mjs` (new) |
| CI | GitHub Actions runs npm test + type-check on push/PR | `.github/workflows/ci.yml` |

---

## V2 substrate — primary path

The V1 SDK loop (per-agent opencode subprocess + SSE chunked streaming) was retired 2026-04-28 alongside the V2 cutover commits. Current architecture:

| Component | File | Status |
|---|---|---|
| State machine | `shared/src/runStateMachine.ts` | primary |
| Observer | `server/src/swarm/blackboard/RunStateObserver.ts` | primary |
| TODO queue | `server/src/swarm/blackboard/TodoQueue.ts` (renamed from V2) | primary |
| Worker pipeline | `server/src/swarm/blackboard/WorkerPipeline.ts` (renamed) | primary; `VerifyAdapter` hook for pre-commit gates (#296) |
| Real fs+git adapters | `server/src/swarm/blackboard/v2Adapters.ts` | primary; #304 fixed inline committer identity |
| Ollama direct client | `server/src/services/OllamaClient.ts` | gated by `USE_OLLAMA_DIRECT=1` per-preset |
| Event log reader | `server/src/swarm/blackboard/EventLogReaderV2.ts` | primary; backs `/api/v2/event-log/runs` |
| `formatServerSummary` | `shared/src/formatServerSummary.ts` | shared between server + web |

**Test totals:** Run `npm test` from the repo root (the shim sets any required env). Current count is the source of truth in CI.
