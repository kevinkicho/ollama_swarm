# Maintenance Log

> Update when performing maintenance work. Used to calibrate the LCCA model
> over time (model drift, dependency updates, bug fixes, documentation).

| Date | Hours | Category | What |
|------|-------|----------|------|
| 2026-05-09 | 0.5 | doc | Dashboard ROI deferral documentation |
| 2026-05-09 | 1.0 | feature | Wall-clock cost attribution (wastedWallClockMs in RunSummary) |
| 2026-05-09 | 2.0 | refactor | Discussion runner consolidation (Council, RoundRobin, 5 budget guards) |
| 2026-05-09 | 0.5 | script | Eval coverage gap analysis |
| 2026-05-09 | 1.0 | script | Drift-cost economic model |
| 2026-05-09 | 0.5 | api | Cascade stats endpoint (/runs/:runId/stats) |
| 2026-05-09 | 1.0 | feature | StaleReason + CommitTier tracking in worker pipeline |
| 2026-05-09 | 0.5 | script | Prompt registry + drift check CI guard |
| 2026-05-09 | 1.0 | feature | Fuzzy hunk search matching |
| 2026-05-09 | 0.5 | feature | Pre-commit semantic validation (large-deletion check) |
| 2026-05-09 | 0.5 | feature | Auditor all-resolved early return |
| 2026-05-09 | 2.0 | feature | Sibling-retry extraction (withSiblingRetry helper) |
| 2026-05-09 | 2.0 | feature | WS authentication (cookie-based token + upgrade interceptor) |
| 2026-05-09 | 1.0 | feature | Multi-tenant cost attribution (UsageRecord.runId) |
| 2026-05-09 | 0.5 | feature | WS payload max-size guard |
| 2026-05-09 | 1.0 | feature | BlackboardRunnerFields typing (runnerContextTypes.ts, 125 properties) |
| 2026-05-09 | 1.0 | refactor | emitOutcome deduplication (createOutcomeEmitter factory) |
| 2026-05-09 | 0.5 | script | Per-preset sweep wall-clock caps |
| 2026-05-09 | 1.0 | feature | Presets readiness matrix (Maturity column in STATUS.md) |
| 2026-05-09 | 0.5 | ops | WSL esbuild guard (preinstall check) |
| 2026-05-09 | 1.0 | ops | OPENCODE_SERVER_PASSWORD optional + git identity warning |
| 2026-05-09 | 0.5 | doc | Model behavior reference doc (model-behaviors.md) |
| 2026-05-09 | 1.0 | feature | Planner 3-file tool limit in system prompt |
|
| **Total** | **20.0** | | |
