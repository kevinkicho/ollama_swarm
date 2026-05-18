# Active work — queued + in-flight (across sessions)

> Persistent TODO list that survives between agent sessions.
> **Update it when you finish or queue work.**

---

## Done recently

### 2026-05-18 — Autoresearch Tier 2–3: test expansion, dead code, archive cleanup

**Test coverage (+161 tests, 2748→2909):**
- Registered 4 orphaned web test files (PlannerThinkingPanel, useReplayState, costBreakdown, store).
- New tests for 3 untested shared utils: stripAgentText (16), extractJson (23), topology (53).
- New tests for 2 untested web modules: agentPalette (11), useSegmentSplitter (20).

**Dead code removal:**
- Deleted `subtaskPart.ts` + its test (zero production imports).
- Deleted `StartConfirmModal.tsx` (import commented out since 2026-05-03).

**Archive cleanup:**
- Deleted 10 archive docs, kept README.md + smoke-tour per plan.

**Commits:** f6da841, 8d0cb26, 2ab3819, 12579d3, edbb364

**Tests: 2748 → 2909 (+161). All passing.**

### 2026-05-17 — Model pipeline consolidation, OpenCode Go fix, zombie prevention, New swarm fix, 17+ fixes

**OpenCode Go provider fixes (2 critical bugs):**
- `stripProviderPrefix` mangled `opencode-go/` prefix → model ID `go/deepseek-v4-pro` → Go detection failed → Zen 401. Fixed in shared/src/providers.ts.
- `response_format` JSON schema → HTTP 400 from DeepSeek Go endpoint. Downgrade to json_object in OpenCodeProvider.ts.

**Model resolution consolidation:**
- Created `shared/src/modelConfig.ts` — `resolveModels()` single pure function replacing 31 scattered decision points. 8 regression tests.
- Server route `swarm.ts` uses `resolveModels()` instead of scattered `eff*Model` + `??` chains.
- TopologyGrid.tsx no longer forces stale defaults onto cached topologies.

**Zombie process prevention (4 fixes):**
- `index.ts` — saved proxy stop handle, properly awaits shutdown (15s deadline, was 5s fire-and-forget).
- `v2Adapters.ts` — process group kill on verify adapter timeout (was leaking grandchildren).
- `treeKill.ts` — SIGKILL escalation after 1s on POSIX.

**Other:**
- "New swarm" button navigates to `/` instead of getting stuck in review mode.
- 17 orphaned test files registered (3 left out due to pre-existing failures).
- `.env.example` updated with 25+ missing vars.
- Type fixes: Agent.port, SwarmPhase union, duplicate RunConfig export, missing config import.
- Doc cleanup across 5 files.

**Tests: 2516 → 2715 (+199). All passing.**

### 2026-05-17 — model_shift raw error + redundant TODOs + transcript history timeline

**BUG: model_shift raw error:** `rawError?: string` added to model_shift event. Populated from `info.classified.rawMessage` in provider failover path. Displayed in web UI and CLI monitor.

**BUG: Planner redundant TODOs:** Filesystem existence check in plannerRunner.ts drops TODOs whose plausible-new files all exist on disk.

**FEATURE: Transcript history timeline:** TranscriptTimeline.tsx component with click-to-expand run details. History tab in SwarmView.

### 2026-05-08 — Worker sibling-retry + P3 quick wins (API versioning, CORS, compression) + static build/deployment

**Worker sibling-retry (1C):** `executeWorkerTodo` now has a full 4-tier parse cascade: `parseWorkerResponse` → repair prompt → `tryBrainFallback` → sibling-retry. When brain fallback fails to extract valid JSON, the worker retries once with a sibling model (via `siblingModelFor()` / `getPlannerFallbackModel()`). Pattern matches the existing planner/contract/auditor implementations — `modelAtEntry` capture at function top, `model_shift` emit on swap, revert in `finally`. Wired `updateAgentModel` + `getPlannerFallbackModel` in `workerContext`.

**P3-1: API versioning middleware** — `apiVersion.ts` adds `X-API-Version: 1.0.0` header to all responses. 3 tests.

**P3-3: CORS middleware** — `cors.ts` with `corsOptions` (origin: true, credentials, maxAge: 86400, allowed headers: Content-Type, Authorization, X-API-Version). 4 tests.

**P3-6: Compression middleware** — `compression.ts` with 1KB threshold + `x-no-compression` request-header passthrough. 3 tests.

**Static build + deployment (2A):** `staticServing.ts` middleware serves `web/dist` assets in production with SPA fallback (non-/api non-/ws GETs fall through to index.html). Configurable via `STATIC_DIR` env var (defaults to `web/dist` relative to server). `Dockerfile` (node:22-slim, two-stage build), `docker-compose.yml` (swarm service, host.docker.internal for Ollama, named volumes for runs/logs), `.dockerignore`. 5 tests.

**Files:** `workerRunner.ts`, `contextBuilders.ts`, `apiVersion.ts` (new), `apiVersion.test.ts` (new), `cors.ts` (new), `cors.test.ts` (new), `compression.ts` (new), `compression.test.ts` (new), `staticServing.ts` (new), `staticServing.test.ts` (new), `index.ts`, `config.ts`, `run-tests.mjs`, `Dockerfile` (new), `docker-compose.yml` (new), `.dockerignore` (new)

**Tests: 2485 → 2500 (+15). All passing.**

### 2026-05-08 — Sibling-retry model capture fix, unknown-error retry-before-swap, port:0 cleanup

**Sibling-retry double-failover model capture bug fixed:** In `plannerRunner.ts`, `contractBuilder.ts`, and `auditorRunner.ts`, `const original = agent.model` was captured *after* `promptPlannerSafely` could have already mutated `agent.model` via provider-level failover (the `onFailover` callback in `promptWithFailover` calls `AgentManager.updateAgentModel()`). Fix: capture `modelAtEntry` at the top of each function before any prompt calls; use `modelAtEntry` in all `fromModel`, `toModel`, `agent.model =`, and `updateAgentModel()` calls in sibling-retry blocks. This ensures `model_shift` events correctly report the true original model and the `finally` block correctly reverts to the true original (not the failover model).

**Unknown-error retry-before-swap:** `promptWithFailover` now tries one additional retry (with 5s backoff) on the same model when `classifyError` returns `"unknown"` before falling through to model swap. An unusual rate-limit format or non-standard 503 might be transient; retrying once is cheaper than immediately swapping to a potentially lower-quality fallback model. Also added `console.warn` logging at the failover layer with model name + raw message for diagnosis. Removed the `console.warn` from `classifyError` itself (redundant with the failover-layer log).

**Port:0 cleanup:** Removed "ready on port 0" messages from `lifecycleRunner.ts` agent-spawn system messages. Now shows model instead: "Planner agent agent-1 ready (model=glm-5.1:cloud)". The UI never rendered port; `agentsReadySummary.ts` never included it; this was a stale display artifact from the E3 Phase 5 opencode-subprocess removal.

**Files:** `plannerRunner.ts`, `contractBuilder.ts`, `auditorRunner.ts`, `promptWithFailover.ts`, `errorTaxonomy.ts`, `lifecycleRunner.ts`

**2337 tests pass.**

### 2026-05-08 — Lenient extraction, wont-do tier-up, partial-progress stop reason, AI brain fallback parser

**Lenient extraction for all 7 parsers:** Instead of dropping entire responses/items when fields slightly exceed Zod schema limits, all 7 parsers (planner, contract, auditor, worker, verifier, replanner, critic) now truncate/slice to the schema max before validation. New shared `lenientParse.ts` module with `lenientPreprocess()` (truncate strings, slice arrays) and `softCap()` (slice top-level arrays instead of rejecting). Soft-cap replaces hard-fail on `MAX_TODOS_PER_BATCH` (5) and `MAX_HUNKS` (8). Worker parser now extracts partial valid hunks + skip on full Zod failure. All 2299 tests pass.

**Wont-do tier-up fix:** `allCriteriaResolved()` counted `wont-do` as resolved, causing runs with `wont-do`+`unmet` criteria to tier-up or claim "completed" incorrectly. New `allCriteriaMet()` (only `status === "met"`) now gates the tier-up decision. When all criteria are resolved (met or wont-do) but not all met, the run stops with completion detail `"N criteria met, M wont-do; remaining unresolvable"`.

**Partial-progress stop reason:** New `StopReason = "partial-progress"` — some criteria met, some wont-do, no unmet remaining. UI renders with sky-blue accent (same visual weight as early-stop). Added to `StopReason` type in both server and web. Added to `ResultChip`, `paletteForStopReason`, `stopReasonAccent`.

**AI brain fallback parser:** New `brainParser.ts` + `brainIntegration.ts` — when any rule-based parser (including lenient extraction) fails, a lightweight "brain" LLM (default: `gemma4:31b-cloud`, configurable via `SWARM_BRAIN_MODEL` env var) attempts to extract structured JSON from the raw model output. Brain calls are logged as `brain-fallback` events for post-run analysis. Wired into all 5 runners (planner, contract, auditor, worker, replanner) — brain sits between repair failure and sibling-retry. `brain-fallback` event type in `SwarmEventBody`. Schema descriptions for all 7 parsers registered. All relevant Zod schemas exported. `SWARM_BRAIN_MODEL` set to empty string disables brain fallback entirely.

**Per-run brain model override:** `brainModel` field on `RunConfig` + `/api/swarm/start` route schema overrides `SWARM_BRAIN_MODEL` per run. Web UI "Brain model" input in SetupForm (under Advanced → Failover chain). `brainConfigFromApp(runModel?)` resolves per-run override → env var → default.

**`brainPromptFn` wired through all context builders:** `PlannerContext`, `ContractContext`, `AuditorContext`, `WorkerContext`, `ReplanContext` all receive `brainPromptFn` (conditionally enabled via `brainEnabled()`). `BlackboardRunner.brainPromptFn` constructs a synthetic brain agent and calls `promptAgent`.

**`BlackboardRunnerFields = any` documented:** 126 property accesses catalogued. Comment added explaining the crash history and incremental typing plan.

**Files:** `lenientParse.ts` (new), `brainParser.ts` (new), `brainParser.test.ts` (new), `brainIntegration.ts` (new), `planner.ts`, `firstPassContract.ts`, `auditor.ts`, `worker.ts`, `verifier.ts`, `replanner.ts`, `critic.ts` (all 7 parsers modified for lenient extraction), `tierRunner.ts`, `summary.ts`, `summary.test.ts`, `plannerRunner.ts`, `contractBuilder.ts`, `auditorRunner.ts`, `workerRunner.ts`, `replanManager.ts`, `BlackboardRunner.ts`, `contextBuilders.ts`, `SwarmRunner.ts`, `types.ts`, `web/types.ts`, `web/RunHistory.tsx`, `web/BoardView.tsx`, `web/RunFinishedGrid.tsx`, `web/SetupForm.tsx`, `config.ts`, `routes/swarm.ts`

**2299 tests pass.**

### 2026-05-08 — Infinite-run stuck-cycle retry + partial-progress stop-reason fix

**Stuck-cycle retry for autonomous runs:** When `rounds=0` (infinite/autonomous) and the auditor + planner fallback both produce no new open todos, the run no longer exits immediately. Instead, it allows up to 3 consecutive stuck cycles before giving up — each logged as `"Stuck cycle N/3 — re-trying in autonomous mode."`. Non-autonomous (finite-round) runs still exit immediately on first stuck cycle. Reset on any successful cycle. New `consecutiveStuckCycles` counter on `TierContext` / `BlackboardRunner`.

**Partial-progress stop-reason fix:** `classifyStopReason` previously only classified a run as `"no-progress"` when ALL criteria were `unmet` AND there was zero board activity. This missed the case where some criteria were `wont-do`/`met` with others still `unmet` and the completion detail said "no new work" — those fell through to misleading `"completed"`. New condition: if the contract has any unmet criteria (but not ALL unmet) and `completionDetail` contains "no new work", classify as `"no-progress"`.

**Files:** `server/src/swarm/blackboard/tierRunner.ts`, `server/src/swarm/blackboard/summary.ts`, `server/src/swarm/blackboard/summary.test.ts`, `server/src/swarm/blackboard/BlackboardRunner.ts`, `server/src/swarm/blackboard/contextBuilders.ts`

**2298 tests pass.**

### 2026-05-08 — Multi-tenant WS hydration bug + post-run contract recovery

**WS connect handler bug:** The `broadcaster.attach` callback in `index.ts` always hydrated new WS connections from `orchestrator.status()` (active runner only), ignoring the `?runId=X` filter the client connected with. For multi-tenant runs, this sent the wrong contract/summary — or no contract at all — on page refresh. Fixed: now calls `statusForRun(runIdFilter)` when the client subscribed with a per-run filter, falling back to `status()` for unfiltered legacy connections.

**Post-run contract recovery:** Two related fixes: (1) `RunStatePersister` now saves the `contract` field to `run-state.json` (v3 schema). Previously, after `runs.delete(runId)` removed the in-memory state, `/api/swarm/runs/:runId/status` returned 404 and the contract was lost forever. (2) `Orchestrator.statusForRun()` now falls back to reading the persister file on disk when the run is no longer in memory, so REST hydration and the WS replay both work for completed runs.

**`Broadcaster.getRunIdFilter(ws)`:** New public method to retrieve the per-client runId filter, needed by `index.ts` to route the initial status replay to the correct run.

**Files:** `server/src/index.ts`, `server/src/ws/broadcast.ts`, `server/src/ws/broadcast.test.ts`, `server/src/services/Orchestrator.ts`, `server/src/services/Orchestrator.multiTenant.test.ts`, `server/src/services/RunStatePersister.ts`

**2299 tests pass.**

### 2026-05-06 — Sibling-retry failover, symbol-grounding, planner fixes, UI sidebar

**Sibling-retry model failover:** When planner/contract/auditor JSON parsing fails (even after repair), the runner retries once with a sibling model before giving up. Five paths (3 planner, 1 contract, 1 auditor). All emit reverse `model_shift` in `finally` blocks so the UI doesn't permanently show the fallback model. `siblingModelFor()` in `BlackboardRunnerConstants.ts` maps primary → fallback.

**Symbol-grounding strips instead of drops:** `checkExpectedSymbols()` now strips hallucinated `expectedSymbols` from a todo rather than dropping the entire todo. A todo with valid `expectedFiles` but invalid symbols keeps its files; only todos failing file-grounding entirely are dropped.

**Planner read-only todo ban:** Hard rule 5a in `planner.ts` explicitly bans read-only TODOs ("read X", "analyze Y"). Workers decline these, wasting cycles.

**Client-side bare todo recognition:** `summarizeAgentJson.ts` now recognizes a single `{description, expectedFiles}` object from planner output (not wrapped in array) and renders it as TodosBubble.

**UI sidebar fix:** Two fixes for stale sidebar on run completion: (1) `AgentManager.killAll()` broadcasts "stopped" states before setting `killed=true`; (2) `setPhase()` clears `agents: {}` on terminal phase transition.

**Runner refactoring:** Extracted `stats` and `writeSummary` to `DiscussionRunnerBase`. MoaRunner override kept as `protected`. 7 runner files simplified.

**Outcome history seeding:** `SEED_DIRECTIVES` in `outcomeHistory.ts` — 12 curated regex patterns mapping common directive shapes to optimal presets. `recommendPreset` checks seed directives before heuristic keywords when history is thin (<5 runs).

**All 2297 tests pass, TypeScript clean (server + web + shared).**

### 2026-05-06 — 7 combination plans + runner refactor + pipeline preset (commit e96d002)

**Completed:** All 7 swarm combination plans implemented, all runners refactored, pipeline preset live end-to-end:

- ✅ Plan 1: `debateAuditor.ts` — PRO/CON/JUDGE debate replaces single-agent audit in blackboard
- ✅ Plan 2: `mapReduceCouncilMapper.ts` — draft→revise per mapper slice for richer reducer inputs
- ✅ Plan 3: `pheromoneHeatmap.ts` — cross-preset file-attention signal from stigmergy → blackboard workers
- ✅ Plan 4: `PipelineRunner.ts` + `pipelinePhases.ts` — chains sub-runs with transcript/deliverable piping
- ✅ Plan 5: `postRoundCritique.ts` — one agent reviews each round for the next (RR/Council/MR/OW)
- ✅ Plan 6: Worker dispositions — rotating Critic/Synthesizer/Gap-finder/Builder in blackboard
- ✅ Plan 7: `postSynthesisCritique.ts` — critic revises synthesis for gaps (Council/MR/OW)

**Runner refactor:** All 8 discussion runners now extend `DiscussionRunnerBase` (~120 LOC shared). Per-runner prompt helpers + deliverable writers extracted into standalone modules. BlackboardRunner: 5606 → 818 LOC (22 extracted modules).

**Route schema:** `"pipeline"` preset + 10 new StartBody fields wired through API. All combination feature toggles in web UI (PresetExtras.tsx).

**Verified:** postRoundCritique working in round-robin run (Round 1/2 Critique system messages observed). Server + web TypeScript clean. Unit tests: 2618 pass, 6 pre-existing failures.

### 2026-05-04 — MultiWriterState integration across all discussion presets (Phase 3.2 complete)

**Completed:** All 9 discussion presets now support multi-writer mode with proposal collection and reconciliation:

- ✅ CouncilRunner (reference implementation from Phase 2)
- ✅ MoaRunner (proposers + aggregators)
- ✅ MapReduceRunner (mappers + reducer)
- ✅ RoundRobinRunner (disposition rotation)
- ✅ DebateJudgeRunner (PRO/CON/JUDGE)
- ✅ OrchestratorWorkerRunner (lead + workers)
- ✅ OrchestratorWorkerDeepRunner (3-tier: orchestrator/mid-leads/workers)

**Pattern applied to each runner:**
1. Import `MultiWriterState` and `DEFAULT_CONFLICT_POLICIES`
2. Add `private multiWriter?: MultiWriterState` field
3. Initialize in `start()` if `cfg.writeMode === "multi"`
4. Collect proposals where agent text is processed (`stripped.finalText`)
5. Reconcile after discussion loop ends, before `maybeRunWrapUpApply()`
6. Apply reconciled hunks via `runWrapUpApplyPhase()`

**Default conflict policies:** council→vote, moa→pick, map-reduce→merge, round-robin→vote, debate-judge→judge, orchestrator-worker→sequential, orchestrator-worker-deep→sequential

**UI:** `WriteSettings.tsx` component with writeMode selector (none/single/multi) and conflictPolicy selector (merge/sequential/vote/judge/pick). State wired through `PresetAdvancedSettings` → `SetupForm` → `/api/swarm/start` POST.

### 2026-05-04 — R1–R17 reliability layer + intra-stream loop detector + Ollama Cloud provider

### Sweep review: results.json commit/health data is all zeros

The `results.json` written by the sweep script shows `"commits": 0, "tier": 0, "healthScore": null` for every entry, but the REPORT.md aggregate shows real numbers. Likely race condition: reads `summary.json` before finalize.

**Fix:** poll/retry loop or read `summary-<iso>.json` instead.
**Trigger:** explicit "go fix sweep results capture."

### Sweep review: cap wall-clock times for discussion presets

Sweep uses uniform 20-min cap across all presets, but discussion presets complete in 1-4 min. Shorter per-preset caps would provide faster failure detection.

**Fix:** per-preset default caps in sweep script or `RunConfig` defaults.
**Trigger:** explicit "go tighten preset caps."

### Ambition for every swarm preset

Only blackboard has an ambition mechanism (tier ratchet). Every other preset does ONE pass and stops. Each preset needs its own "now go further" lever.

**Trigger:** explicit "go implement preset-X ambition" (one at a time).

### Cloud-quota-burning validation

- **Multi-repo blackboard validation.** Want 2-3 different repo types to surface V2 worker pipeline scenarios (large hunks, conflicts, multi-file commits).
  **Trigger:** explicit "go run multi-repo validation."
- **Long-horizon blackboard run with tier ratchet.** 2-4 hours continuous. Validates pause/resume, tier promotion at scale.
  **Trigger:** explicit "go long-run."

### V2 Step 6c — UI cuts over to event-log-derived state

Foundation shipped; first thin slice shipped (`GET /api/v2/event-log/runs/:runId`). Remaining UI-side work scoped in `docs/V2-STEP-6C.md`.
**Trigger:** focused refactor session.

### User chat doesn't reach blackboard/MoA agents

`/api/swarm/say` pushes to `runner.transcript` but blackboard reads from a separate `AmendmentsBuffer` and MoA's `buildProposerPrompt`/`buildAggregatorPrompt` never read user entries. Display-only for these two presets.
**Fix:** `Orchestrator.injectUser` also call `addAmendment`; MoA thread `userMessages` param.
**Trigger:** after sweeps finish.

### Planner JSON drift on context-heavy seeds

Open-weights cloud models drift into XML pseudo-tool-calls under repeated structured-output pressure, exacerbated by larger seed context. Constrained decoding (`format` param) for todo-generation prompts should force valid JSON only.
**Fix:** add `ollamaFormat` schema to planner todo-batch prompt path.
**Trigger:** explicit "go fix planner JSON drift."

### ~~Sibling-retry double-failover model capture bug (plannerRunner.ts)~~ (FIXED)

~~When provider-level failover swaps `agent.model` (e.g. glm→nemotron via `promptWithFailover`), the sibling-retry block in `runPlanner` captures `original = agent.model` at line 131 — but `agent.model` has already been updated to the failover model by the `onFailover` callback. So the `finally` block restores to the *failover* model (nemotron), not the *original* model (glm).~~

**Fixed:** `modelAtEntry` captured before any prompt calls in `plannerRunner.ts` (3 blocks), `contractBuilder.ts` (1 block), and `auditorRunner.ts` (1 block). All sibling-retry blocks now use `modelAtEntry` instead of reading `agent.model` after prompt calls.

### ~~Blackboard sibling-retry also applies to 0-grounded-todos path (line 247)~~ (FIXED)

~~When `groundedTodos.length === 0` after file+symbol grounding, the code at line 247 checks `!isFallbackAttempt` to decide whether to attempt sibling-retry.~~

**Fixed:** Same `modelAtEntry` pattern covers this path. The `model_shift revert` event is correctly emitted in the `finally` block.

### ~~Worker failover "non-retryable unknown" — error taxonomy gap~~ (FIXED)

~~Workers failing with "non-retryable unknown" and immediately swapping models instead of retrying.~~

**Fixed:** `promptWithFailover` now retries once (5s backoff) on `"unknown"` errors before swapping. `console.warn` added at failover layer with model name + raw message. Redundant `console.warn` removed from `classifyError`.

### ~~Drop obsolete port:0 from agent UI + transcript~~ (FIXED)

~~After E3 Phase 5 removed the opencode subprocess, agents no longer have per-agent ports — the `port` field is always `0`.~~

**Fixed:** System messages in `lifecycleRunner.ts` now show model instead of port: "Planner agent agent-1 ready (model=glm-5.1:cloud)".

~~Planner occasionally generates todo descriptions longer than the 500-char `max(500)` in the Zod schema (`PlannerTodoSchema`). The planner prompt says "one imperative sentence" but models sometimes write long descriptions with rationale. The dropped todo wastes a planner slot.~~
**Fixed:** All 7 parsers now truncate over-size fields before Zod validation instead of dropping the entire item.

### ~~Tier-ratchet criteria with all-expectedFiles-stripped~~ (PARTIALLY FIXED — wont-do auto-marking still pending)

~~When the ambition ratchet promotes to tier 3, the planner generates new criteria whose `expectedFiles` reference directories that don't exist in the repo. The path validation layer strips these as "suspicious", resulting in criteria with zero accepted paths that are effectively unverifiable.~~
**Partially fixed:** `lenientPreprocess` truncates `expectedFiles` arrays; `allCriteriaMet` correctly distinguishes met from wont-do. Auto-marking entirely-unbindable criteria as `wont-do` still pending.

---

## Done recently

### 2026-05-04 — R1–R17 reliability layer + intra-stream loop detector + Ollama Cloud provider

- 17 standalone helpers + 250 tests (R1–R17 reliability layer)
- Wave 1/2/3 wiring: failover, backoff, loop detection, health tracking
- Intra-stream loop detector (R9 extended) + REPLANNER_JSON_SCHEMA + contract constrained decoding
- `OllamaCloudProvider` with `:cloud` model routing (direct `https://ollama.com/api/chat` with Bearer auth)
- Every "deferred" item shipped + multi-tenant runs + per-run zustand factory
- Doc cleanup: 29 → 20 .md files; resolved limitations pruned

### 2026-05-01 — 5 features × 3 layers + MoA + scoreboard + UI bug fixes

- Constrained decoding, self-consistency hunks, MoA preset, SWE-Bench Lite, time-travel replay UI
- Scoreboard publishing plan retired (hardware too slow, no Anthropic budget)
- 3 UI bug fixes (streaming swaps, MoA status stuck, segment escape)

### 2026-04-29 — E3 Phase 5: removed opencode subprocess dependency

- All 9+ runners route through `pickProvider` → in-process `chatOnce` → direct HTTP
- `@opencode-ai/sdk` removed; ~2000 LOC of dead subprocess code deleted
- Multi-provider support (Ollama / Anthropic / OpenAI) + cost cap + baseline runner + fixture framework + scoreboard aggregator

### 2026-04-27 — V2 substrate complete, validation tour, bug fixes

- V2 Steps 1–6a shipped; SSE-aware watchdog; WSL path normalization
- 8-preset validation tour: 7/7 PASS (discussion), 3/3 FAIL (blackboard/ow-deep model drift)
- XML pseudo-tool-call stripping (#229/#230); think-tag support; contract bubble; content-boundary segmentation
---

## Queued

### Provider integration tests ✅ (shipped 2026-05-17)

Added `server/src/providers/openCodeProvider.test.ts` (12 tests) and `server/src/routes/smoke.test.ts` (5 tests). Covers: opencode-go/zen prefix detection/ stripping, pickProvider routing with full model string, resolveModels cross-layer contract (planner = model for blackboard, explicit wins over topology). Tests: 2715 → 2732 (+17).

### Cross-layer smoke tests ✅ (shipped 2026-05-17)

`server/src/routes/smoke.test.ts` — 5 tests verify resolveModels correctly preserves user model, explicit plannerModel wins over topology, non-blackboard presets share model, empty falls to defaults.

---

### Fix uncaughtException handler ✅ (shipped 2026-05-17)

`server/src/index.ts:411-415` — `uncaughtException` now calls `shutdown("uncaughtException")` before `process.exit(1)` instead of immediately killing the server.

### Add try/catch around dynamic imports in swarm.ts routes ✅ (shipped 2026-05-17)

All 9 `await import(...)` calls in `swarm.ts` routes now wrapped in try/catch with 500 error responses.

### Fix MemoryStore silent write error ✅ (shipped 2026-05-17)

`MemoryStore.ts:191-195` — `dirty = false` moved into `.then()` callback, only resets on successful write.

### Route 10 process.env bypasses through config.ts ✅ (shipped 2026-05-17)

Added `USE_OLLAMA_DIRECT`, `USE_WORKER_PIPELINE_V2`, `SWARM_DISABLE_TOOLS_AUTO`, `CONFORMANCE_MONITOR` to `config.ts` Zod schema. Updated 4 call sites from `process.env.XYZ` to `config.XYZ`.

### Plug 27 fetch() AbortController leaks in web UI ✅ (polling sites shipped 2026-05-18: 02af84f)

Added `AbortController` + `{ signal }` to `EventLogPanel.tsx` and `RunHistory.tsx` — the two components with race conditions on rapid open/close. Remaining 25 sites are lower priority (single-submit forms, fire-and-forget calls).

---

### Pre-flight model validation before run starts (3 hr, medium risk)

Every run failure we debugged in this session — OpenCode Go 401, response_format 400, model_shift to nemotron — could have been caught with one 50 ms API call per model before posting the first TODO. Currently the failure surfaces 2-5 minutes into a run after the planner has been thinking.

**Do:** After `resolveModels()` produces the final model set, call `provider.chat()` with a tiny prompt ("hi") for each unique model. If any fail with 401/400/timeout, block the run with a clear error: "Model opencode-go/deepseek-v4-pro is unreachable: HTTP 400 — unknown format variant 'object'. Try a different model." Stores results in a per-run health snapshot for the debug panel (see below).

**Trigger:** "go pre-flight model validation"

### Single "current run" debug panel (4 hr, low risk)

Tracing why run 66165913 used glm-5.1 instead of opencode-go required following 31 decision points across 15 files. A `/api/runs/:id/resolution` endpoint + debug panel showing each model field's source (explicit, topology, default, config) would answer this in one glance.

**Do:**
1. Add `GET /api/runs/:id/resolution` endpoint that returns the resolved model chain for the active/target run
2. Add a debug tab (collapsed by default, behind a gear icon) showing a table: Field | Value | Source (explicit | topology | model fallback | config default)

**Trigger:** "go debug resolution panel"

### Remove invisible Advanced model defaults (2 hr, medium risk)

The `plannerModel`/`workerModel`/`auditorModel` Advanced fields default to `glm-5.1:cloud`/`gemma4:31b-cloud`/`nemotron-3-super:cloud`. These defaults are invisible to users who don't open Advanced, yet they override the user's top-level model selection. This caused both the 77ec1450 and 66165913 bugs.

**Do:** Remove the hardcoded defaults from `BlackboardSettings.tsx` and `SetupForm.tsx`. If user doesn't open Advanced, every agent uses the top-level `model`. If they explicitly set per-role overrides, those win. Placeholder text shows "Uses default model" instead of the hardcoded value.

**Trigger:** "go remove advanced model defaults"

### Server startup health check (1 hr, zero risk)

At server startup: check if ports are free, if orphaned processes exist, if disk space ≥2 GB. Log warnings instead of silently starting on wrong port or running out of disk mid-run.

**Do:** Add a `startupHealthCheck()` function in `index.ts` that runs before the server starts listening. Logs warnings for: port conflict, orphaned opencode PIDs, disk <2 GB free.

**Trigger:** "go startup health check"

### Delete archive docs ✅ (shipped 2026-05-18: edbb364)

Deleted 10 files from `docs/archive/`. Kept `README.md` and `smoke-tour-2026-04-25.md` per the queued plan. Git history preserves the content.

**Trigger:** "go delete archive docs"

### Dead code removal ✅ (shipped 2026-05-18: 12579d3)

Deleted `subtaskPart.ts` + its test (zero production imports) and `StartConfirmModal.tsx` (import commented out since 2026-05-03).

### Test coverage expansion ✅ (shipped 2026-05-18: f6da841, 8d0cb26, 2ab3819)

Registered 4 orphaned web test files, wrote new tests for 5 untested modules (stripAgentText, extractJson, topology, agentPalette, useSegmentSplitter). **Tests: 2748 → 2909 (+161). All passing.**

---

---

### Add diff syntax highlighting to WorkerHunksBubble (2 hr, medium risk)

`WorkerHunksBubble.tsx` renders hunks as plain monospace text with rose/emerald backgrounds for removed/added lines. No syntax highlighting — all code looks the same regardless of language. Large diffs (>12 lines) are collapsed with a "show all" button, making review cumbersome.

**Do:** Add a lightweight syntax highlighter (e.g., `highlight.js` or `shiki`) scoped to file extension detected from the hunk's file path. Also add a "copy" button per hunk. Increase default visible lines from 12 to 24.

**Trigger:** "go hunk syntax highlighting"

### Fix MessageBubble missing-summary-kind fallback (1 hr, low risk) ✅ (shipped 2026-05-18: 26a1227)

`MessageBubble.tsx` has 18+ dispatch branches driven by `entry.summary.kind`. If a new kind is added server-side but the client doesn't have the corresponding bubble, it silently falls to `AgentClientFallback` which re-parses the JSON from scratch. This doubles the parse work and can produce wrong renderings (e.g., a new `worker_hunks_v2` kind would render as raw JSON instead of diffs).

**Do:** Add a `default` case in the agent and system dispatchers that renders an "Unknown summary kind: {kind}" badge + the raw text. Logs a `console.warn` so new kinds are visible in dev tools. Also add a test that iterates all known summary kinds from `shared/src/transcriptEntrySummary.ts` and verifies each has a dispatch branch.

**Trigger:** "go message bubble fallback"

### Improve splitProseAndJson robustness (1 hr, low risk)

`JsonBubbles.tsx:splitProseAndJson()` splits agent responses into prose preamble + JSON body by finding the first `{`, `[`, or `` ```json ``. Some models emit non-standard JSON wrappers (e.g., raw `{` after markdown explanation, or `JSON:` prefix). The current algorithm fails on these, dumping the entire response as prose.

**Do:** Add a third fallback strategy: if no standard JSON boundary is found, try `repairAndParseJson` (the same lenient parser the server uses) on the full text. If it successfully extracts JSON, use the first parseable span. Also add test cases for 5 known failure patterns.

**Trigger:** "go split prose json robust"

### Add transcript entry count and run-phase timeline to transcript view (2 hr, low risk)

The transcript is a flat list of entries with auto-scroll. There's no visual indication of how many entries exist, which phase the run was in at each point, or how much time elapsed between events. The only phase indicators are RUN-START and RunFinishedGrid.

**Do:** Add a sticky timeline column (or hover tooltip on each entry) showing: phase at entry time, wall-clock elapsed, entry index (e.g., "entry 47/230"). Add a mini phase-timeline bar at the top of the Transcript tab (similar to YouTube chapters) showing phase transitions.

**Trigger:** "go transcript timeline"

### Fix streaming dock stalled-entry leak (30 min, low risk)

The `StreamingDock` has a 30-second safety sweeper that force-clears stuck "done" streaming entries that were never replaced by `transcript_append`. This is a workaround for the real bug: if `transcript_append` never arrives (e.g., agent crashed, event loss), the streaming bubble stays visible forever until the sweeper fires.

**Do:** Add a per-agent `streamingTimeout` (90s) that auto-scrubs streaming entries when no `agent_streaming` chunk has arrived for that duration. Remove the 30s sweeper. Also add a visual "stalled" state (greyed out with ⚠ icon) between streaming timeout and transcript arrival.

**Trigger:** "go streaming dock stall fix"

## Conventions for this file

- **Add an entry when you queue work.**
- **Move to "Done recently" with a commit hash when shipped.** Items older than ~30 days can fall off (git log is the durable record).
- **Trigger field is required for "Queued."**
- **Don't list work that doesn't exist yet** — this is a TODO, not a wish list.