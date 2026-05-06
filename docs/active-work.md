# Active work — queued + in-flight (across sessions)

> Persistent TODO list that survives between agent sessions.
> **Update it when you finish or queue work.**

---

## Done recently

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