# Changelog

All notable changes to ollama_swarm. Reverse chronological order.
The git log is the authoritative record; this summarizes user-facing changes.

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

**Worker sibling-retry.** 4-tier parse cascade: parse → repair → brain fallback → sibling retry. All 6 retry paths now share `withSiblingRetry()`.

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
