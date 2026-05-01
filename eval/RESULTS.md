# Open-weights swarm scoreboard

**Status:** PARTIAL — Sweep 1A baseline complete (2026-05-01); Sweep 1B blackboard in flight; Sweep 2 analysis pending.

This file is the published scoreboard for the project's open-weights value-prop test. It will be updated as each sweep lands. Pre-filled methodology + caveats below; numbers tables are populated incrementally.

---

## What's being measured

Two scoreboards, two different questions:

### Scoreboard A — code-modify (file-write tasks)

**Question:** does swarm orchestration beat a single-shot agent on tasks that require file changes?

**Configs:**
- `baseline` — 1 Ollama agent, 1 prompt, 1 apply step. The "thinnest honest comparison."
- `blackboard` — planner + workers + auditor with the worker pipeline + CAS conflict detection.

**Tasks:** 10 fixtures in `eval/fixtures/` (off-by-one, null-guard, refactor, rename, fix-failing-test, README section, structured emit ×2, multi-step ×2). Each verified by a `verify.mjs` that exits 0 on pass.

**Why MoA is NOT in this scoreboard:** MoA is discussion-only — produces prose synthesis, never writes files. Can't pass code-modify verifies by design. See `project_moa_discussion_only.md` in memory for the full reasoning.

### Scoreboard B — analysis (prose-deliverable tasks)

**Question:** does Mixture of Agents synthesis beat other discussion patterns on prose-deliverable tasks?

**Configs:**
- `moa` — N proposers (peer-hidden) + K aggregators (synthesize). Discussion-only.
- `council` — N drafters parallel, then converge over rounds. Discussion-only.
- `round-robin` — N agents take turns on a shared transcript. Discussion-only.

**Tasks:** 3 non-fixture catalog tasks (`audit-readme-claims`, `council-architecture-decision`, `stigmergy-coverage-map`). Each is graded by transcript quality + on-topic-ness (see "Quality scoring" below). No fixture-style verify.

---

## Methodology

- **3 seeds per (preset, task)** for noise reduction. 5 seeds would be tighter; cost scales linearly.
- **Wall-clock cap:** 600s per attempt for fixtures (bumped from 300s after Tour caught blackboard timing out at the 5-min cap).
- **Models:** all Ollama-via-cloud. Defaults — baseline: `glm-5.1:cloud`. Blackboard per-role: planner `glm-5.1:cloud`, worker `gemma4:31b-cloud`, auditor `nemotron-3-super:cloud`. Provider stack documented in `server/src/providers/`.
- **Per-attempt isolation:** each attempt gets a freshly-staged git-init'd fixture clone (no cross-attempt state leak).
- **Verify gate:** fixtures use `verify.mjs` that exits 0 on pass. Pass-rate = (verify=PASS attempts) / (total attempts).
- **Score:** `eval/run-eval.mjs`'s `scoreRun` — 40 completion + 30 throughput + 20 efficiency + 10 conformance + ±50 verify bonus/penalty. Range [0, 150]. Higher = better.

---

## Sweep 1A — baseline × 10 fixtures × 3 seeds

**Status:** ✅ COMPLETE (2026-05-01, 7.5 min wall-clock, $0)

| Fixture | pass/3 | median score | median wall (s) |
|---|---|---:|---:|
| add-null-guard | **3/3** ✅ | 50 | 17 |
| add-readme-section | **3/3** ✅ | 50 | TBD |
| fix-off-by-one | 0/3 | 0 | 2 |
| extract-pure-helper | 0/3 | 0 | TBD |
| rename-symbol | 0/3 | 0 | TBD |
| fix-failing-test | 0/3 | 0 | TBD |
| audit-console-logs | 0/3 | 0 | TBD |
| categorize-deps | 0/3 | 0 | TBD |
| multistep-add-script | 0/3 | 0 | TBD |
| multistep-config-then-test | 0/3 | 0 | TBD |
| **Overall** | **6/30 (20%)** | — | — |

**Reading:** baseline's single-shot solves boilerplate (null-guard, readme section) cleanly but fails on bug-fixes-with-context, refactors, multi-file consistency, structured-emit-to-disk, and multi-step coordination. This is the floor swarm presets must beat.

---

## Sweep 1B — blackboard × 10 fixtures × 3 seeds

**Status:** 🟡 IN FLIGHT (kicked 2026-05-01 PM)

[Numbers will land here when the sweep completes. Per-task table will mirror Sweep 1A's shape.]

---

## Sweep 2 — moa + council + round-robin × 3 analysis tasks × 3 seeds

**Status:** ⏳ PENDING (needs target repo selection)

[Numbers will land here. Quality scoring approach for analysis tasks documented separately.]

---

## What this isn't (limitations)

1. **N=10 fixtures + 3 analysis tasks** is small. Per-task verdicts shouldn't be over-claimed; medians are stable but per-cell variance is wide.
2. **3 seeds** smooths some LLM-output noise but not all. 5 would be tighter.
3. **Open-weights via :cloud** is "open weights" by model identity, hosted by Ollama's cloud partners — NOT self-hosted GPU. A truly self-hosted comparison would change the cost calculus.
4. **No paid provider in this scoreboard.** Per Kevin's 2026-05-01 strategic note: the project's value prop is open-weights multi-agent parallelism, not paid-provider wrapping. Direct API users with Claude Pro/Max get more capacity for less than this orchestration tax. So the scoreboard compares Ollama configs against each other, not against Sonnet.
5. **No SWE-Bench Lite numbers yet.** SWE-Bench requires Docker-based test isolation (executor module shipped 2026-05-01 in `eval/swe-bench/dockerExecutor.mjs`); real-image smoke-test is Kevin's laptop-side step before the full sweep.
6. **Verify gates are local-Node.** Env-compatible tasks only. SWE-Bench-style "tests pass against the real upstream environment" is the harder bar — separate scoreboard once Docker is wired.

---

## Provenance

- Plan: `docs/SCOREBOARD-PUBLISHING-PLAN.md`
- Catalog: `eval/catalog.json` (10 fixtures + 4 non-fixture tasks)
- Per-attempt artifacts: `runs/_eval/sweep1-baseline/`, `runs/_eval/sweep1-blackboard/`, `runs/_eval/sweep2-analysis/`
- Per-attempt summaries: `runs/_eval/<sweep>/per-run/<task>__<preset>__seed<N>__<ts>.json`
- Aggregator: `eval/aggregate.mjs` reads results.json files, computes per-cell median + IQR

To reproduce a sweep yourself:
```bash
# Pre-flight: make sure dev server up + Ollama models pulled
node scripts/scoreboard-tour.mjs    # smoke-test all 4 free configs against ONE fixture

# Sweep 1A baseline
node eval/run-eval.mjs --fixture-dir=eval/fixtures --presets=baseline --seeds=3 \
  --model=glm-5.1:cloud --out=runs/_eval/sweep1-baseline

# Sweep 1B blackboard
node eval/run-eval.mjs --fixture-dir=eval/fixtures --presets=blackboard --seeds=3 \
  --out=runs/_eval/sweep1-blackboard

# Sweep 2 analysis (needs --repo target)
node eval/run-eval.mjs --repo=<your/target> --presets=moa,council,round-robin --seeds=3 \
  --moa-aggregator-model=nemotron-3-super:cloud \
  --out=runs/_eval/sweep2-analysis

# Aggregate
node eval/aggregate.mjs runs/_eval/sweep1-baseline runs/_eval/sweep1-blackboard runs/_eval/sweep2-analysis
```
