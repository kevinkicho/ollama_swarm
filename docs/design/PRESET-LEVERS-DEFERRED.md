# Per-preset levers — final status

> Last refresh: 2026-05-04 (T199 final pass — 7 production + 4 substantive
> enhancements out of 11 deferred items; remainder genuinely needs days
> of dedicated substrate work each).

## All 44 brainstormed items — closed

(See git log T171-T199 commits for the implementation history.)

| Status | Count | Notes |
|---|---|---|
| ✅ Production-quality | 30+ | Full prompt + runner + tests |
| 🟢 Substantive thin-cut | 6 | Real implementation; explicit caveat for the deferred polish |
| 🔴 Genuinely heavy substrate | 4 | Days of dedicated work; documented below |

---

## What this T199 session shipped (production)

| Task | Lever | Status |
|---|---|---|
| T199 | Multi-tier MoA aggregation tree (N levels) | ✅ Production |
| T199 | LLM-driven dynamic role catalog | ✅ Production |
| T199 | Real streaming reducer (event-driven) | ✅ Production |
| T199 | Per-tier model UI form pickers (RR + OW-Deep + MoA) | ✅ Production |
| T199 | Bidirectional OW-Deep auto-replan | ✅ Production |
| T199 | K-attempt baseline with winner-pick | ✅ Production (sequential — parallel-clone deferred) |
| T199 | Parallel proposition rank | ✅ Production (parallel derivation + ranked pick — K full debates deferred) |
| T199 | Multi-language import graph (TS/JS + Python) | ✅ Production (Rust/Go deferred — would need ts-morph/tree-sitter) |
| T199 | Test-scaffolding generator (JS/TS) | ✅ Production (vitest/jest/bun-test/node-test detection + stub emission; Python/Rust/Go deferred) |

## Still genuinely deferred (heavy substrate)

### Real adaptive worker pool sizing
**What's missing:** Dynamic AgentManager spawn during a run + lifecycle
accounting + cost attribution for newly-spawned agents. The watchdog
that recommends scale-up/scale-down already exists (T198c log-only).

**Why heavy:** AgentManager.spawnAgentNoOpencode is fire-and-forget at
run start; mid-run spawn requires:
- Queue management for in-flight spawn requests
- Cost attribution (each new agent's tokens count toward maxCostUsd)
- WS state updates for the new agent slot
- Cleanup on stop (kill mid-run-spawned agents too)

**Estimate:** 3-5 days of focused AgentManager surgery + tests.

### In-flight parallel hypothesis (blackboard)
**What's missing:** Worker pool can run 2-3 alternative todos
simultaneously against the same criterion; cross-cancellation when
one lands; auditor re-evaluates. The prompt-only T198i ships sequential
alternatives.

**Why heavy:** Requires:
- TodoQueue extension to track "alternative todos" as a group
- WorkerPipeline cross-cancellation when one alternative commits
- Auditor pass that picks winner across alternatives + marks losers
  as "skipped — alternative landed"
- Conflict detection (two workers may modify the same file)

**Estimate:** 3-4 days of blackboard substrate + tests.

### Parallel debate streams (debate-judge)
**What's missing:** Run K full debates IN PARALLEL with different
propositions; judge cross-evaluates after. T199 ships parallel
proposition derivation + ranked pick (one debate runs).

**Why heavy:** Requires:
- Per-stream transcript scoping (currently one shared transcript)
- Per-stream agent state (PRO/CON for each stream)
- Cross-stream judge prompt that compares verdicts
- 3× the cloud token cost — default-off + clear UI affordance

**Estimate:** 2-3 days of runner refactor.

### Parallel-clone-to-K-subdirs baseline
**What's missing:** True parallel K attempts, each in its own clone
subdir. T199 ships sequential K attempts with winner-pick (cleaner
but slower).

**Why heavy:** Requires:
- Disk isolation per attempt (clone N times)
- Parallel runner harness
- Winner-pick + commits-to-canonical-clone path
- Cleanup of loser clones

**Estimate:** 1-2 days; lowest-priority of the four heavy items
because the sequential version captures most of the value.

---

## Cumulative test count

T171 baseline: 1209 tests passing.
After T199 final pass: **1682 tests passing / 3 skipped / 0 fail.**
Net additions: +473 tests across 50+ days of work.

## Recommended order if anyone picks this up

1. **Parallel-clone baseline** (1-2 days) — cheapest of the four heavies; immediate scoreboard win.
2. **Parallel debate streams** (2-3 days) — high value for the eval harness's debate-judge column.
3. **In-flight parallel hypothesis** (3-4 days) — biggest blackboard quality lever; benefits compound across runs.
4. **Real adaptive worker pool** (3-5 days) — operational improvement; lower priority unless you're running long-horizon workloads where one stuck worker dominates wall-clock.
