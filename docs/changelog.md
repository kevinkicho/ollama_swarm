# Changelog

All notable changes to ollama_swarm. Reverse chronological order.
The git log is the authoritative record; this summarizes user-facing changes.

## 2026-07-10 — Guards without Jaccard, Brain reconfig, quality levers, dead-code prune

**Loop policy (docs + code).** Primary automated stops **are** empty/junk output, plan-empty, wall-clock/token/quota caps, and board/ledger stuck. Optional Jaccard/embedding remains a secondary “discussion settled” signal only (log re-reads share vocabulary while work continues). See `docs/decisions.md` (2026-07-10) and `docs/postmortems/stream-guards-removed.md`.

**Guard → Brain → UI.** Shared `guardNotify.ts` injects Brain suggestions (or transcript fallback) with optional `RECONFIG` JSON. Sleep-safe discussion wall-clock watchdog. Status fields: `drainEligible`, `drainIneligibleReason`, `capsRemaining`, `earlyStopDetail`. UI: `RunHealthChip`, drain tooltip/caps hint, `BrainSuggestionBubble` one-click reconfig apply.

**Quality levers (opt-in API flags).** Wired: `failurePatternSeed` (blackboard seed), `preserveDissent` (council synthesis), `selfCritique` + `swapSidesBiasCheck` (debate judge), `pheromoneDecay` (stigmergy), `midCycleBroadcast` (map-reduce sequential broadcast). Schema + start route accept these and related library flags.

**spawnAgent cleanup.** Single `AgentManager.spawnAgent` API; removed `spawnAgentNoOpencode` alias.

**Dead-code purge.** Removed ~24 never-imported modules (orphan UI, unwired multi-repo/decomposer/SubRunProtocol, PortAllocator leftovers, patch panels, etc.). Scanner: `scripts/_dead-code-scan.mjs` + `scripts/_dead-code-report.md`.

**Also:** Mechanical modularization of large runners/routes into focused modules (prior commits on same branch stream).

## 2026-07-07 — Planner grounding truncation, thinking UX, parse-salvage

**Planner `expectedFiles` truncation (run `94224a3e`).** `lenientPreprocess` caps planner todos at 2 `expectedFiles`. When the model lists new-file paths first, both kept paths can be grounding-rejected and valid registry paths truncated away → `no-progress` with 0 todos. `prioritizeExpectedFilesSlice()` now keeps shallow config/registry paths over deep `sources/` / `panels/` trees when slicing. Postmortem: `docs/postmortems/run-94224a3e.md`.

**Thinking / pseudo-tool display.** DeepSeek v4 explore turns emit nested `<function><function name>read</function><parameter name="path">…</parameter></function>` blocks inside `thoughts` and bubble text. `extractToolCallMarkers` strips these server-side; `parseThinkingDisplay` + `AgentThinking.tsx` show prose plus a collapsible "Intended tool calls" list. `stripAgentText` also strips pseudo-tool XML from `thoughts`.

**Parse-salvage cascade (runs `4b2da092` and peers).** Shared `extractJsonCandidate` / `parseJsonEnvelope`; blackboard parsers migrated; auditor salvage after repair for worker/replanner/hunk-review/auditor paths; `assistKind: "auditor-salvage"` chip in transcript. Council `councilBuildSeedContext()` fix for `getPlanner is not a function` when council uses contract derivation.

**Tests:** new/updated `lenientParse.test.ts`, `extractToolCallMarkers.test.ts`, `parseThinkingDisplay.test.ts`, `stripAgentText.test.ts`, parse-salvage suites.

## 2026-07-07 — No in-run brain fallback; auditor arbitrates worker refusals

**In-run brain retired.** The system/brain agent no longer jumps into runs as a parse referee. `brainEnabled()` is always false; parse cascade is parse → repair → auditor interpretation → sibling-retry. Post-run brainOverseer analysis unchanged.

**Auditor arbitration.** Workers must give reasons when declining todos. Auditor verdicts: valid refusal → replanner; invalid refusal (sufficient tools) → todo released to board; hallucinated-todo → replanner; insufficient-tools → skipped with systemic finding exposed. Planner/auditor never do the worker's job.

## 2026-07-08 — Stop/drain lifecycle documentation + execution close-out hardening

**Docs:** Added `docs/run-stop-drain-lifecycle.md` — canonical contract for hard stop vs
soft drain, council `workerDrainPromise` wait, transcript freeze, `killAll` session abort,
and debugging checklist. Indexed from `DOCUMENTATION_INDEX.md`, `AGENT-GUIDE.md`,
`decisions.md`, `known-limitations.md`, `swarm-patterns.md`, `STATUS.md`.

**Council stop (code):** Close-out waits for execution workers before summary/killAll;
hard `stop()` no longer sets `drainRequested`; literature pre-pass and hunk repair use
abort signals; `killAll` aborts provider sessions; transcript frozen after summary write.
(See decision in `docs/decisions.md` 2026-07-08.)

---

## 2026-07-07 — Research tools, council close-out, transcript UX

**Web tools expansion.** Shared `toolProfiles.ts` now resolves `swarm-planner`, `swarm-research`, and `swarm-builder-research` profiles when `webTools` or `plannerTools` is enabled. Discussion presets upgrade legacy `swarm-read` profiles via `effectiveToolProfileId`. Blackboard runs a **research pre-pass** (`researchPrePass.ts`) before JSON-locked contract turns. Tool calls are logged to the transcript via `toolCallTranscript.ts`. `RESEARCH_PIPELINE` phase added to pipeline preset.

**Council stop / close-out.** `CouncilRunner.stop()` now enters `stopping` → writes summary → `killAll` → `stopped` (was draining 30s with no summary). `ensureTerminalCloseOut()` backstop on loop `finally`. `runFinallyHooks` kills agents and sets `stopped` even when phase is mid-run. `crashSummaryRecovery.ts` synthesizes `summary.json` from `.run-state.json` when a run is interrupted; `Orchestrator.statusForRun` uses it for historical failed runs. `ActiveRun.stop()` backfills crash summary when none on disk.

**Transcript + execution UX.** Council cycle stage markers (`council_cycle` / `council_stage`) with `CouncilCycleDivider.tsx`. `ExecutionStatusBubble.tsx` + `elapsed.ts` show live elapsed time on in-flight "working on" lines. `councilWorkerRunner` marks agents `thinking` with `thinkingSince` during todos. `SwarmView` Stop sets `stopping` immediately (not `stopped`).

**Drafts tab.** Structured council draft display via `councilDraftParse.ts` + `DraftMatrix.tsx` (replaces raw JSON blobs).

**Tests:** 3,220+ passing. New/updated: `CouncilRunner.test.ts`, `councilWorkerRunner.test.ts`, `CouncilCycleDivider.test.ts`, `crashSummaryRecovery.test.ts`, `runFinallyHooks.test.ts`, `researchPrePass.test.ts`, `toolCallTranscript.test.ts`, `pipelinePhases.test.ts`.

## 2026-07-05 — Complete removal of hybrid mode

**Hybrid mode fully removed** from the app (per user request due to persistent issues with flickering, agent status signals showing "ready" while working, transcript gaps, sidebar agents, stop buttons, etc.).

- Removed all `useHybridPlanning`, `planningPreset`, `executionPreset` fields, schema support, UI toggles (PlanningPhaseControl), special logic in Orchestrator (createHybridPipelineRunner, buildRunner branch), PipelineRunner hybrid stripping, SwarmView sidebar/terminal/role logic, store/provider isHybrid checks, types, etc.
- Frontend and backend cleaned; no more hybrid-specific orchestration or guards.
- For similar workflows: use the `pipeline` preset (explicit chaining) or run pure presets (council then blackboard) separately.
- All docs updated to reflect removal. No functional references remain in code.
- Typechecks pass. Pre-existing presets (blackboard, council, pipeline, etc.) unaffected.

## 2026-05-18 — Import path fix + rate limiter isolation + express import

**Cross-package import fix.** Commit `3b51973` deleted 3 web shim files and redirected their callers directly to `shared/src/`, but the callers in `components/transcript/` are one directory deeper than the old shims. `../../../` from that depth reaches `web/`, not the project root — off by one `../`. Fixed the 3 affected imports: `../../../shared/` → `../../../../shared/`.

**Rate limiter test isolation.** The `rateLimit` factory shared a module-level `entries` Map, causing test cross-contamination. Changed to per-instance state. Also fixed 3 test cases with inverted assertion logic (`blocked` was set to `true` in `next()` callback, meaning "allowed", but assertions expected it to mean "blocked").

**Missing express import.** `server/src/index.ts` was missing `import express` — server failed to start.

**AGENT-GUIDE.md:** Clarified that `npm run dev` works from WSL; only `npm install` is the WSL hazard.

**Vite fs.allow:** Added to `vite.config.ts` to allow resolving imports outside the web directory.

**Tests:** 3,168 passing, 0 failing.

## 2026-05-17 — Model pipeline consolidation + OpenCode Go fix + zombie prevention

**Model resolution consolidation.** Created `shared/src/modelConfig.ts` — single `resolveModels()` replaces 31 scattered decision points. Fallback: explicit → topology → role default → model → config default. Server route, topology overlay, and localStorage all use same resolution.

**OpenCode Go provider fixes.** Two critical bugs: `stripProviderPrefix` mangled `opencode-go/` → `go/deepseek-v4-pro` causing 401 auth errors. JSON schema `response_format` caused HTTP 400 from DeepSeek Go endpoint. Both fixed.

**Zombie process prevention.** 4 fixes: proxy stop handle saved + shutdown properly awaited (15s deadline), verify adapter process group kill on timeout, treeKill SIGKILL escalation, session abort cleanup. Clean shutdown verified.

**"New swarm" button.** Navigates to `/` instead of getting stuck on "Waiting for agents..." during historic run review.

**Type fixes.** Agent.port restored, SwarmPhase union expanded, duplicate RunConfig export removed, missing config import added, RunSummary.deliverables field added.

**Orphaned test files.** 14 registered (3 excluded due to pre-existing failures).

**Tests:** 2516 → 2715 (+199). All passing.

## 2026-05-17 — model_shift raw error + redundant TODOs + transcript timeline

**model_shift rawError.** `rawError?: string` added to model_shift event. Populated from classified error raw message in provider failover path. Displayed in UI and CLI monitor.

**Planner redundant TODOs.** Filesystem existence check drops TODOs whose plausible-new files all exist on disk. Prevents "32/32 skipped" pattern.

**Transcript history timeline.** New TranscriptTimeline.tsx component with click-to-expand run details. History tab in SwarmView.

## 2026-05-09 — Bus-factor remediation + observability + hunk quality

**Bus-factor remediation.** BlackboardRunnerFields typed (125-property generated interface). DiscussionRunnerBase consolidation (Council -117 LOC, RoundRobin -43 LOC). RunnerFactory (Orchestrator -8 imports). types.ts split into domain files. Sibling-retry shared helper extracted. LifecycleState single source of truth. WSL esbuild guard.

**Observability.** StaleReason + CommitTier tracking. Cascade stats endpoint. Multi-tenant token attribution. Wall-clock cost attribution (wastedWallClockMs). Region status API plumbed.

**Hunk quality.** Trailing-whitespace normalization. Pre-commit large-deletion validation. Hunk quality as 5th eval dimension. 6 fuzzy-matching regression tests.

**Env docs.** 25+ missing vars added to .env.example.

**Tests:** ~2,400 → 2,516.

## 2026-05-08 — Worker sibling-retry + P3 quick wins + Docker

**Worker sibling-retry.** 4-tier parse cascade: parse → repair → auditor interpretation → sibling retry. All 6 retry paths now share `withSiblingRetry()`. (Brain in-run fallback removed 2026-07-07.)

**P3 quick wins.** API versioning (X-API-Version header), CORS middleware, compression middleware, WS auth (cookie token), WS payload guard, rate limiting, global error handler.

**Docker.** Two-stage Dockerfile, docker-compose.yml, SPA fallback static serving.

**Sibling-retry fix.** modelAtEntry captured before any prompt to prevent double-failover model corruption. Unknown-error retry-before-swap.

**Tests:** 2,485 → 2,500 (+15).

## 2026-05-04 — R1-R17 reliability layer

17 standalone pure helpers: provider failover (R1), quota probe backoff (R2), degradation fallback (R3), cost projector (R4), auto-resume (R5), drain-stop policy (R6), subscriber pause (R7), clone lock (R8), loop detector (R9), model health tracker (R10), JSON repair (R11), disk check (R12), memory pressure (R13), memory pruner (R14), auto RCA (R15), health score (R16), error taxonomy (R17). Wired into all 9 non-blackboard runners. 9 new env flags.

**Write-capable discussion presets.** `cfg.writeMode: "single"` added to all 9 discussion presets. Synthesizer produces hunks after discussion.

**Multi-tenant runs.** Per-runId zustand factory, WS subscriber filter, concurrency cap, per-run REST routes, ActiveRunsPanel.

**Tests:** 1,209 → 1,848 (+~640).

## 2026-05-03 — Ollama Cloud provider + setup form UX

Ollama Cloud as 4th provider. Multi-provider live model discovery. Setup form UX overhaul (sticky start CTA, first-time chips, auto-resize directive textarea, recently-used chips). All 9 discussion presets honor user directives.

## 2026-05-01 — 31 commits day

5 features × 3 layers each: constrained decoding, self-consistency hunks, MoA preset, time-travel replay, SWE-Bench Lite integration. Provider streaming chunk-drop fix. Dotenv root-path fix. 3 UI bug fixes.

---

## Maintenance log

Hours per category, used to calibrate the LCCA economic model:

| Date | Hours | Category | What |
|------|-------|----------|------|
| 2026-05-17 | 0.5 | bug | model_shift raw API error captured (rawError field) |
| 2026-05-17 | 1.0 | bug | Planner redundant TODO detection (filesystem check) |
| 2026-05-17 | 1.5 | feature | Transcript history timeline + History tab |
| 2026-05-17 | 1.0 | feature | OpenCode Go/Zen provider (5th provider) |
| 2026-05-09 | 0.5 | doc | Dashboard ROI deferral documentation |
| 2026-05-09 | 1.0 | feature | Wall-clock cost attribution (wastedWallClockMs) |
| 2026-05-09 | 2.0 | refactor | Discussion runner consolidation |
| 2026-05-09 | 0.5 | script | Eval coverage gap analysis |
| 2026-05-09 | 1.0 | script | Drift-cost economic model |
| 2026-05-09 | 0.5 | api | Cascade stats endpoint (/runs/:id/stats) |
| 2026-05-09 | 1.0 | feature | StaleReason + CommitTier tracking |
| 2026-05-09 | 0.5 | script | Prompt registry + drift check CI guard |
| 2026-05-09 | 1.0 | feature | Fuzzy hunk search matching |
| 2026-05-09 | 0.5 | feature | Pre-commit large-deletion validation |
| 2026-05-09 | 0.5 | feature | Auditor all-resolved early return |
| 2026-05-09 | 2.0 | feature | Sibling-retry extraction (withSiblingRetry) |
| 2026-05-09 | 2.0 | feature | WS authentication (cookie token) |
| 2026-05-09 | 1.0 | feature | Multi-tenant cost attribution |
| 2026-05-09 | 0.5 | feature | WS payload max-size guard |
| 2026-05-09 | 1.0 | feature | BlackboardRunnerFields typing (125 properties) |
| 2026-05-09 | 1.0 | refactor | emitOutcome deduplication |
| 2026-05-09 | 0.5 | script | Per-preset sweep wall-clock caps |
| 2026-05-09 | 1.0 | feature | Presets readiness matrix |
| 2026-05-09 | 0.5 | ops | WSL esbuild guard |
| 2026-05-09 | 1.0 | ops | OPENCODE_SERVER_PASSWORD optional + git identity |
| 2026-05-09 | 0.5 | doc | Model behavior reference doc |
| 2026-05-09 | 1.0 | feature | Planner 3-file tool limit |
| **Total** | **24.0** | | |
