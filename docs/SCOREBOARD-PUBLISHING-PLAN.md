# Open-weights MoA scoreboard — credible publishing plan

**Last updated:** 2026-05-01
**Status:** ready to execute (pending Kevin's go-ahead on cost-bearing phases)

This is a concrete plan for what a defensible "open-weights swarm beats single-big-model" published result looks like. Every command, model, fixture, and cost is named — you can paste the runbook and execute, or hand it to a future agent session to drive.

---

## Goal

Produce `eval/RESULTS.md` with a per-task × per-config scoreboard that:

1. Shows **N small open-weights models in MoA** beating a **single Claude Sonnet baseline** on a meaningful subset of fixtures
2. Is **reproducible** (methodology + commands documented; runs persisted)
3. Has **honest caveats** (sample size, env-incompatible tasks, cost asymmetry)

The thesis being tested: *"5 small open-weights models in parallel can match or beat 1 big paid model on practical coding tasks at a fraction of the cost."*

---

## Configuration matrix (the actual claim)

| Config | Preset | Planner / Layer-1 model | Worker / Layer-2 model | Why |
|---|---|---|---|---|
| **A. Solo Ollama baseline** | `baseline` | `glm-5.1:cloud` | — | Cheapest possible "what does ONE local model do?" floor |
| **B. Solo Claude baseline** | `baseline` | `anthropic/claude-sonnet-4-6` | — | The bar to clear: one big paid model, no orchestration |
| **C. Blackboard Ollama** | `blackboard` | `glm-5.1:cloud` planner / `gemma4:31b-cloud` worker / `nemotron-3-super:cloud` auditor | (per-role) | This project's flagship preset, all open-weights |
| **D. MoA homogeneous** | `moa` | `glm-5.1:cloud` × 5 proposers / × 1 aggregator | — | Pure MoA effect (vs solo Ollama A) |
| **E. MoA heterogeneous** | `moa` | `gemma4:31b-cloud` × 5 proposers / `nemotron-3-super:cloud` × 1 aggregator | — | The headline claim — small fast layer + big synthesis layer |

5 configs × 10 fixtures × 3 seeds = **150 attempts**.

---

## Task set: 10 fixtures (all wired in `eval/catalog.json` as of 2026-05-01)

| Fixture id | Type | Difficulty | Verify gate |
|---|---|---|---|
| `fix-off-by-one` | Code-modify (loop bug) | low | `countDown(3)` returns `[3,2,1]` |
| `add-null-guard` | Code-modify (defensive) | low | `formatUser(null)` doesn't throw |
| `extract-pure-helper` | Refactor | medium | `applyTax` exists + `computePrice` preserved |
| `rename-symbol` | Multi-file consistency | medium | no `oldSum` references in src/ |
| `fix-failing-test` | Constraint-respecting | low | tests pass + `src/sum.js` unmodified |
| `add-readme-section` | Doc-writing | low | `## Usage` section + code example |
| `audit-console-logs` | Analysis (structured emit) | medium | `report.json` with file:line precision |
| `categorize-deps` | Structured-data extract | low | `categories.json` with 3 buckets |
| `multistep-add-script` | Multi-file (entry + script) | medium | `npm run greet` prints `hello, world!` |
| `multistep-config-then-test` | Code + paired test | high | `formatLog` verbose works + test exists + passes |

Mix is intentional: 4 code-modify, 2 multi-file, 2 analysis/structured, 2 multi-step. No SWE-Bench in this matrix (separate phase below).

---

## Pre-flight checklist

```bash
# 1. All 10 fixtures wired in catalog
node -e "console.log(require('./eval/catalog.json').tasks.filter(t => t.fixture).length)"
# expected: 10

# 2. Required Ollama models pulled
ollama list | grep -E "glm-5\.1|gemma4|nemotron"
# expected: all three present

# 3. ANTHROPIC_API_KEY set in .env (Phase B only)
grep "^ANTHROPIC_API_KEY=sk-ant" .env
# expected: one line

# 4. Dev server up + healthy
curl -s http://localhost:8243/api/providers | grep '"hasKey":true'
# expected: ollama AND anthropic both true

# 5. Fresh disk space (clones eat ~50MB per attempt × 150 = 7.5GB peak)
df -h /c/Users/kevin/Desktop/ollama_swarm/runs
# expected: ≥ 20GB free
```

If any item fails, do NOT start the sweep. Each missing prerequisite costs hours of mid-sweep debugging.

---

## Phase 1 — Free Ollama-only sweep (Configs A, C, D, E)

**Cost:** $0 (pure Ollama). **Wall clock:** ~6–10 hours (single sequential machine).

```bash
# Phase 1a: Solo Ollama baseline (Config A)
node eval/run-eval.mjs \
  --fixture-dir=eval/fixtures \
  --presets=baseline \
  --seeds=3 \
  --model=glm-5.1:cloud \
  --out=runs/_eval/scoreboard-A-baseline-ollama
# 10 fixtures × 1 preset × 3 seeds = 30 attempts; ~30 min

# Phase 1b: Blackboard Ollama (Config C) — uses per-role defaults
node eval/run-eval.mjs \
  --fixture-dir=eval/fixtures \
  --presets=blackboard \
  --seeds=3 \
  --out=runs/_eval/scoreboard-C-blackboard-ollama
# 10 × 1 × 3 = 30; ~3-4h (blackboard is slowest preset)

# Phase 1c: MoA homogeneous (Config D)
# Need to add "moa" to each catalog task's presets array first, OR
# pass --presets=moa override (existing flag handles this).
node eval/run-eval.mjs \
  --fixture-dir=eval/fixtures \
  --presets=moa \
  --seeds=3 \
  --model=glm-5.1:cloud \
  --out=runs/_eval/scoreboard-D-moa-homogeneous
# 10 × 1 × 3 = 30; ~1-2h (MoA has fewer rounds than blackboard)

# Phase 1d: MoA HETEROGENEOUS (Config E — the headline claim)
# Per-layer model split via cfg.moaProposerModel + cfg.moaAggregatorModel.
# These aren't yet exposed via run-eval.mjs CLI flags — need a small
# patch first OR a one-off script that hits /api/swarm/start directly
# with the per-layer model fields.
node eval/run-eval.mjs \
  --fixture-dir=eval/fixtures \
  --presets=moa \
  --seeds=3 \
  --moa-proposer-model=gemma4:31b-cloud \
  --moa-aggregator-model=nemotron-3-super:cloud \
  --out=runs/_eval/scoreboard-E-moa-hetero
# 10 × 1 × 3 = 30; ~2h

# Phase 1 aggregate
node eval/aggregate.mjs runs/_eval/scoreboard-A-baseline-ollama runs/_eval/scoreboard-C-blackboard-ollama runs/_eval/scoreboard-D-moa-homogeneous runs/_eval/scoreboard-E-moa-hetero
# Writes eval/RESULTS.md with median + IQR per cell
```

**Checkpoint:** at this point you have 4 of the 5 configs measured against the same 10 fixtures × 3 seeds. Open `eval/RESULTS.md` and verify the table makes sense before spending money on Phase 2.

---

## Phase 2 — Paid Claude baseline (Config B)

**Cost:** estimated $15–25 (10 fixtures × 3 seeds × ~$0.30–0.80 per attempt). **Wall clock:** ~1 hour.

Only run AFTER Phase 1 is in the bag — no point spending Claude credit if the open-weights side hasn't actually completed cleanly.

```bash
node eval/run-eval.mjs \
  --fixture-dir=eval/fixtures \
  --presets=baseline \
  --seeds=3 \
  --model=anthropic/claude-sonnet-4-6 \
  --maxCostUsd=1.00 \
  --out=runs/_eval/scoreboard-B-baseline-claude
# 10 × 1 × 3 = 30 attempts; per-attempt cap $1, sweep cap $30

# Aggregate ALL 5 configs
node eval/aggregate.mjs runs/_eval/scoreboard-*
```

---

## Result interpretation guide

The published claim survives only if:

1. **Config E (MoA hetero) ≥ Config A (solo Ollama)** by ≥10 points median across the 10 fixtures. Below that, the MoA orchestration overhead isn't earning its compute.
2. **Config E (MoA hetero) ≥ Config B (solo Claude) × 0.85** on pass-rate (verify=PASS counts). The "near parity at fraction of cost" framing requires this. ≤ 0.7× ratio = the claim doesn't hold.
3. **Config C (blackboard) ≥ Config A** clearly. If blackboard isn't beating solo Ollama on these tasks, the project's main preset is in trouble.

If any of these fails, the result is still publishable — just with the framing reversed ("MoA didn't beat solo Claude on this task set; here's where the gap is largest"). Honesty is the headline.

**Per-task drift signal:** a single fixture where Config E loses to Config A by >30 points is more interesting than the median. Surface those rows in the published table.

---

## Honest limitations to surface in the published doc

1. **N=10 fixtures** is a small sample. Variance is wide; per-task verdicts shouldn't be over-claimed.
2. **3 seeds** smooths some LLM-output noise but not all. 5 seeds would be better; cost scales linearly.
3. **Open-weights Ollama via :cloud** uses Anthropic-hosted infra (Together / Anyscale / etc.) — it's "open weights" by model identity but not "self-hosted GPU." A truly self-hosted comparison would change the cost calculus.
4. **Cost ratio** in published claim should be tokens-based, not dollars-based — Ollama-via-cloud also has a $/token rate. Use:
   - `summary.totalPromptTokens + summary.totalResponseTokens` per attempt
   - Apply pricing from `server/src/services/CostTracker.ts` per (provider, model)
5. **No SWE-Bench Lite numbers** in this scoreboard. SWE-Bench is a separate (Phase 3) effort once Docker integration is smoke-tested. Comparable-to-published-baselines numbers come from THERE, not from these synthetic fixtures.
6. **Verify gates are local-Node** — env-compatible tasks only. SWE-Bench-style "tests pass against the real upstream environment" is the harder bar.

---

## Phase 3 — SWE-Bench Lite micro-sweep (optional follow-up)

Adds external comparability (numbers vs published GPT-4 / Sonnet / Devin / Aider scoreboards). Requires:

1. Docker installed + working on Kevin's machine
2. `dockerExecutor` smoke-tested against ONE real SWE-Bench image (`docker pull swebench/sweb.eval.x86_64.<task>:latest` + a manual `executeInContainer` call — see `eval/swe-bench/README.md`)
3. SWE-Bench Lite JSONL downloaded to `eval/swe-bench/dataset/lite.jsonl`
4. Wiring `executeInContainer` into `run-eval.mjs`'s SWE-Bench mode (~1h follow-up commit)

**Cost:** $0 (Ollama-only) for the open-weights configs; ~$50–100 for a Sonnet baseline against the same task subset (SWE-Bench tasks burn more tokens than synthetic fixtures).

**Sample size:** 10–20 tasks from the Node-friendly subset (the env-compatible ones the adapter doesn't skip). Gives directional signal vs published numbers without committing the full ~$500–1000 of a complete Lite run.

---

## What this plan deliberately does NOT include

- **Multi-machine scaling** — all single-laptop. Distributed Ollama would 2–3× wall-clock.
- **Hyperparameter sweep** — fixed K=3 seeds, fixed agent count per preset. Searching over (K, temperature, rounds) is a research project, not a publishing sweep.
- **Cross-language tasks** — all fixtures are JS/TS. Python/Go/Rust would need separate fixture work.
- **A/B vs older versions** — this is a snapshot of "as of 2026-05-01 with all today's commits in." Comparing to historical versions needs git-checkout-and-re-run.

---

## Pre-publishing TODOs (small, ~2h total)

1. **Wire `--moa-proposer-model` + `--moa-aggregator-model` into `run-eval.mjs`** so Config E is one-command runnable. Currently they're RunConfig fields exposed via `/api/swarm/start` but not surfaced as eval CLI flags. ~30 min.
2. **Add `moa` to each catalog task's `presets` array** so Phase 1c+1d don't need `--presets=moa` override (or keep the override pattern — works either way). ~5 min.
3. **Update `eval/RESULTS.md` placeholder** with the methodology + caveats sections from this doc baked in. ~30 min.
4. **Tour-script all 5 configs end-to-end against ONE fixture first** (5 attempts total, ~10 min) before kicking the full 150-attempt sweep. Catches "moa preset isn't accepted by route" / "ollama model not pulled" / etc. early.

---

## Decision gate

Before kicking Phase 1, Kevin should agree to:

- [ ] **Phase 1 scope** (Configs A, C, D, E × 10 fixtures × 3 seeds = 120 attempts, ~6–10h, $0)
- [ ] **Phase 2 commit** ($15–25 on Sonnet baseline, only after Phase 1 lands cleanly)
- [ ] **Disk budget** (~7.5GB peak in `runs/`; `scripts/prune-runs.mjs` handles cleanup after)
- [ ] **Time window** (sweep runs unattended; Kevin's machine needs to stay up)
- [ ] **Acceptance criteria** ("publish if Config E ≥ Config B × 0.85 OR if there's an interesting per-task surprise")

---

## What the published `eval/RESULTS.md` looks like

```markdown
# Open-weights MoA scoreboard — 2026-05-01

> 5 small open-weights models orchestrated via Mixture of Agents
> matched single-Claude-Sonnet performance on 7 of 10 fixtures at
> 1/Nx the API cost. Methodology + caveats below — judge before
> sharing.

| Fixture | Solo Ollama (A) | Blackboard Ollama (C) | MoA homo (D) | **MoA hetero (E)** | Solo Claude (B) |
|---|---:|---:|---:|---:|---:|
| fix-off-by-one | 0/3 | 3/3 | 2/3 | **3/3** | 3/3 |
| add-null-guard | 3/3 | 3/3 | 3/3 | **3/3** | 3/3 |
| ... | ... | ... | ... | ... | ... |
| **Median pass-rate** | 30% | 70% | 60% | **80%** | 90% |
| **Median wall-clock** | 5s | 60s | 40s | 80s | 12s |
| **Median cost** | $0 | $0 | $0 | $0 | $0.42 |

**Headline:** MoA hetero (E) is at 89% of Solo Claude (B) accuracy
at 0% of the cost. Blackboard (C) lands between.

[methodology section]
[caveats section]
[per-task commentary on the 3 fixtures where MoA hetero lost]
```

---

## What I'll do next IF Kevin says go

1. Pre-flight TODOs (~2h) — wire `--moa-*-model` flags + tour-script
2. Kick Phase 1 — Ollama-only sweep, monitor periodically, notify on completion
3. Land `eval/RESULTS.md` with Phase 1 numbers + methodology
4. Wait for Phase 2 go-ahead (cost-bearing)
5. Kick Phase 2 once approved
6. Final `eval/RESULTS.md` with all 5 configs + caveats

If Kevin says "just do everything" — same plan, no checkpoint pause between phases. But the cost gate at $25 is worth keeping explicit.
