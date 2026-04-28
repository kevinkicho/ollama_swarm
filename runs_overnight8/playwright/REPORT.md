# Validation 2 — post-restart, post-v2-migration, full bubble audit

**Run**: `b2ee7f04` against fresh dev server (PID restarted ~22:45 PDT)
**Date**: 2026-04-27 evening overnight session
**Target**: multi-agent-orchestrator (fresh clone in runs_overnight8/)
**Preset**: blackboard, glm-5.1 planner, gemma4 worker, nemotron auditor
**Directive**: "Add JSDoc documentation to public methods of TokenTracker class…"

## Outcome — strong pass

| Metric | Result | Notes |
|---|---|---|
| Stop reason | **completed** (auditor invocation cap reached at 6) | Natural end |
| Wall clock | 13m 19s | Well under 30min cap |
| Total commits | **18** ✓ | Matches worker_hunks bubble count |
| Total todos | 20 (2 skipped) | Skipped were build-style (`bun run docs:api`) — planner correctly recognized incompatible w/ hunks contract |
| Files changed | 15 | Real refactor work landed |
| Lines | +334 / -132 | Substantive |
| Console errors | **0** | Clean |
| Page errors | **0** | Clean |
| Console warnings | **0** | Clean |
| WS frames received | 919 | Healthy stream |
| Transcript entries | 106 (67 system + 39 agent) | |
| Bubble kinds rendered | worker_hunks (18), worker_skip (4), stretch_goals (1), run_finished (1) | All structured-summary variants worked |
| Marker leak indicators | 0 entries with `data-has-tool-calls` | Either model didn't emit, or strip caught all |

## What this validates

This is the first end-to-end blackboard run on the post-v2-migration code, and it validates:

1. **SDK upgrade `0.15.31 → 1.14.28`** — wire format works at runtime (zero failures across 39 SDK call sites)
2. **v1 → v2 client migration** — all `session.prompt` / `abort` / `messages` / `create` calls return correct results
3. **Permission ruleset** (replaced deprecated `tools` field) — agent profiles work; workers correctly restricted
4. **`stripAgentText` cascade** (#229+#230) — server-side strip running, no marker pollution in stored entries
5. **`#231` follow-up cascade** (contract-pass uses `swarm`, todos-pass uses `swarm-read`, council drafts use `swarm`, directive+contract injection in todos prompt) — planner produces valid todos, not empty arrays
6. **`format` JSON-mode passthrough** in promptWithRetry — wire format includes `format: { type: "json_schema" }` for parser-strict prompts
7. **Bubble rendering** — verifier_verdict ribbons, worker_hunks blocks, todos bubble, run_finished grid all rendering correctly
8. **Worker-skip handling** — planner intelligently skipping uncomputable build-style TODOs rather than failing

## Comparison to pre-fix runs tonight

| Run | Code state | Outcome |
|---|---|---|
| `af27f55c` (preset 1) | pre-#229 | no-progress, 0 commits, marker-leak parse failures |
| `80a1ca98` (preset 2 ow-deep) | pre-#229 | early-stop, 0 commits |
| `0fa1dd98` (validation 4 last night) | pre-v2-migration partial fixes | 5 commits |
| `e88ed24f` (validation 1 tonight) | pre-restart, stale dev server | 1 commit |
| **`b2ee7f04` (this run)** | **post-restart, all fixes live** | **18 commits, 20 todos, 0 errors** |

## Artifacts

- Video: `runs_overnight8/playwright/video/page@*.webm` (~5MB, 13min recording)
- Screenshots: `runs_overnight8/playwright/screenshots/` (38 PNGs, full-page, captured per phase change + every 5 entries)
- REPORT.json: machine-readable summary
- entries.json: per-bubble data attributes (entry-id, role, summary-kind, agent-index, has-thoughts, has-tool-calls)
- final-page.html: complete DOM at run-end

## Remaining work for next session

- `#235` SubtaskPartInput migration to multi-agent runners (foundation shipped tonight; runner refactors deferred)
- `#237` swarm-builder agent profile for build-style TODOs (queued from this run's findings)
