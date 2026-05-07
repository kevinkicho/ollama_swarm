# Active work — queued + in-flight (across sessions)

> Persistent TODO list that survives between agent sessions.
> **Update it when you finish or queue work.**

---

## Done recently

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

### Drop obsolete port:0 from agent UI + transcript

After E3 Phase 5 removed the opencode subprocess, agents no longer have per-agent ports — the `port` field is always `0`. UI still renders `:0` and the system message says "3/3 agents ready on ports 0, 0, 0".

**Fix:** hide port field when 0, or delete the field. Update `agentsReadySummary` to show model breakdown instead.
**Trigger:** explicit "go drop the port displays."

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

### Sibling-retry double-failover model capture bug (plannerRunner.ts)

When provider-level failover swaps `agent.model` (e.g. glm→nemotron via `promptWithFailover`), the sibling-retry block in `runPlanner` captures `original = agent.model` at line 131 — but `agent.model` has already been updated to the failover model by the `onFailover` callback. So the `finally` block restores to the *failover* model (nemotron), not the *original* model (glm). This means:

1. The `model_shift revert` event says `nemotron → glm` instead of `glm → glm` (no-op revert).
2. If the sibling-retry re-prompt hits a provider error on glm, `promptWithFailover` will swap back to nemotron — creating a bounded but wasteful loop (up to `maxSwaps=3`).

**Fix:** Capture `original` before the `promptPlannerSafely` call (before provider failover can mutate `agent.model`), then restore to that true original in the `finally` block.

Also: the 0-or-1 todo threshold (`parsed.todos.length <= 1` at line 128) means a single valid todo triggers sibling-retry, wasting a prompt turn. Consider lowering to `=== 0` or making it configurable.

**Files:** `server/src/swarm/blackboard/plannerRunner.ts` lines 62-67, 128-161
**Trigger:** explicit "go fix sibling-retry model capture."

### Blackboard sibling-retry also applies to 0-grounded-todos path (line 247)

When `groundedTodos.length === 0` after file+symbol grounding, the code at line 247 checks `!isFallbackAttempt` to decide whether to attempt sibling-retry. If `isFallbackAttempt=true` (already in a sibling-retry), `fallback` is `undefined` and the function silently gives up. This is correct (prevents infinite loops) but the transition is invisible to the user — no `model_shift revert` event is emitted for this "give up" path. The run continues with 0 new todos, likely ending with "no progress" or "auditor cap."

**Fix:** emit a `model_shift revert` in the `finally` block of this path as well, matching the pattern used in the other sibling-retry paths.
**Trigger:** same session as the model-capture fix above.

### Worker failover "non-retryable unknown" — error taxonomy gap

Workers (gemma4:31b-cloud) are failing with "non-retryable unknown" and falling back to nemotron-3-super:cloud. This means `classifyError` in `errorTaxonomy.ts` doesn't match the error gemma returns. Likely causes: rate limit with unusual format, 503 with non-standard body, or connection reset. Instead of retrying (which would succeed after a brief wait), the system immediately swaps model — wasting a prompt budget and producing lower-quality output from the fallback model.

**Fix:** (a) Add logging of the raw error message whenever `classifyError` returns "unknown" so the exact error can be diagnosed. (b) Consider treating "unknown" as retryable with a short backoff (1 retry, 5s delay) before swapping models. (c) Check if gemma4:31b-cloud is returning a new error format not covered by the existing patterns in `errorTaxonomy.ts`.
**Files:** `server/src/swarm/errorTaxonomy.ts`, `server/src/swarm/promptWithFailover.ts`
**Trigger:** explicit "go diagnose worker failover unknown errors."

### Planner todo description exceeds 500-char Zod limit

Planner occasionally generates todo descriptions longer than the 500-char `max(500)` in the Zod schema (`PlannerTodoSchema`). The planner prompt says "one imperative sentence" but models sometimes write long descriptions with rationale. The dropped todo wastes a planner slot.
**Fix:** (a) Truncate descriptions to 500 chars in `parsePlannerResponse` instead of dropping. (b) Add a prompt instruction reinforcing brevity. (c) Consider increasing the limit to 800 or making it configurable.
**Files:** `server/src/swarm/blackboard/prompts/planner.ts` lines 60, 77
**Trigger:** explicit "go fix planner todo description length limit."

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

## Conventions for this file

- **Add an entry when you queue work.**
- **Move to "Done recently" with a commit hash when shipped.** Items older than ~30 days can fall off (git log is the durable record).
- **Trigger field is required for "Queued."**
- **Don't list work that doesn't exist yet** — this is a TODO, not a wish list.