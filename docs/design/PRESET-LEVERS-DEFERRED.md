# Per-preset levers — deferred to follow-up sessions

> Companion to the 2026-05-04 preset-improvements brainstorm + ship.
> Items below were brainstormed but NOT implemented in that session
> because each needs substrate work that's days-to-weeks of focused
> effort. Listed roughly by leverage so a future session can pick the
> next biggest win.

## What DID ship 2026-05-04 (T171-T179)

| Task | Preset | Lever |
|---|---|---|
| T171 | cross-cutting | Verify-gated wrap-up apply (cfg.verifyCommand honored by maybeRunWrapUpApply) |
| T172 | round-robin | Cross-round flips section in synthesis (convergence-aware termination already shipped) |
| T173 | council | Forced steelmanning in R2+ + per-position confidence weighting |
| T174 | map-reduce | Mapper specialization (lens-per-mapper: correctness/security/performance/architecture/testability/ux-and-docs) |
| T175 | OW (flat) | Per-subtask successCriteria rubric + worker self-eval |
| T176 | debate-judge | Loser-perspective preservation as "Known risks" + canonical wrap-up apply wired (verifyCommand-gated) |
| T177 | stigmergy | Typed pheromones (relevant/dead-end/needs-more-eyes/contradicts) — evaporation already shipped |
| T178 | MoA | 3 new proposer biases (creative/empirical/conservative) + aggregator confidence tag + parser |
| T179 | baseline | Recent commit context in prompt + structured self-critique pass (parser + prompt builder) |

All ship as opt-in or backward-compatible — no preset's default
behavior changed; each new lever is either prompt-only (zero runtime
cost when ignored) or gated on a new opt-in cfg field.

---

## Deferred — heavy substrate (days each)

### Smart slicing by import graph (map-reduce)
**Idea:** group files that import each other into the same mapper
slice instead of even file-count round-robin. Coherent context per
mapper, fewer cross-slice merge headaches in the reducer.

**Why heavy:** needs an import-graph parser (ts-morph or babel for TS,
ast-grep cross-language). Has to handle aliased imports, dynamic
imports, re-exports. Probably ~2-3 days of focused work for a
TS-only first cut, plus another day to handle Python/JS.

**Foundation:** map-reduce's slicing is in `sliceRoundRobin`; the
import-graph version would be a sibling function that reads files +
parses them.

**When to do this:** after a real run where round-robin slicing
visibly hurt synthesis quality. Until then, the lens specialization
shipped in T174 may be sufficient.

### Test-driven todo expansion (blackboard)
**Idea:** planner proposes a failing test FIRST, worker makes it
pass; verify gate confirms. Turns "did the worker do something" into
"did they make a measurable thing change."

**Why heavy:** test-scaffolding is language-specific. JS/TS via vitest
or jest with simple assert patterns is doable; cross-language is
substantial. Also needs planner-prompt + auditor-prompt restructuring
to think test-first.

**Foundation:** the verify gate (cfg.verifyCommand) and the
WorkerPipeline's apply-and-revert path are already in place — the
missing piece is a planner that says "here's the failing test" and a
todo schema with separate test-file + impl-file expectedFiles.

### Auditor "partial" → parallel hypothesis (blackboard)
**Idea:** when auditor verdict is "partial," split the unmet
criterion into 2-3 alternative todos and run them in parallel; pick
whichever lands first.

**Why heavy:** needs the auditor to emit structured alternatives
(currently it emits prose verdicts), AND the runner to manage
multiple in-flight competing todos with cross-cancellation when one
succeeds.

**Foundation:** auditor verdicts already exist; the structured-
alternatives output + competing-todos runner are new.

### Two-stage aggregation (MoA)
**Idea:** K mid-aggregators each synthesize a subset of proposers,
top aggregator synthesizes the K mid-syntheses. Beats single-
aggregator collapse on long contexts.

**Why heavy:** MoaRunner currently has K-aggregator parallel + central-
pick; this would be a new tree shape with proposer→mid-agg→top-agg
that the runner has to manage. Not impossible but ~1-2 days for the
runner + new prompt builders.

**Foundation:** AGGREGATOR_VARIANTS + the K-aggregator path that
already exists.

### Bi-directional refinement (OW-Deep)
**Idea:** mid-leads can push back on the orchestrator's decomposition
(today it's strictly top-down). Surfaces "this subtask doesn't make
sense" early.

**Why heavy:** OW-Deep is currently single-pass tree dispatch. Bi-
directional needs a feedback channel + protocol for push-back +
re-decomposition. ~1-2 days for the protocol + ~1 day for the prompts.

### Adaptive worker pool sizing (blackboard)
**Idea:** scale workers based on todo backlog (more todos = more
workers; fewer when backlog drains).

**Why heavy:** AgentManager spawn/teardown is currently fire-and-
forget at run start. Dynamic spawn during a run needs careful
lifecycle management + cost accounting.

### Cross-cluster discovery via import graph (stigmergy)
**Idea:** when an explorer surfaces a finding, plant pheromones on
related files (importers/importees). Coverage spreads through code
structure.

**Why heavy:** same import-graph dependency as map-reduce smart
slicing. Best done together so the parser is built once.

---

## Deferred — substantial but doable in 1-2 sessions

### Dynamic role catalog (role-diff)
**Idea:** planner reads the directive and picks roles. "Refactor auth"
→ +Auth, +Security, +Migration. Today the same 7 roles fire whether
the directive is a web app or a data pipeline.

**Why deferred:** needs a directive-keyword → role mapping (or an
LLM-driven role picker) + role catalog generator. Probably 1-2 days of
focused work. The role catalog already exists (DEFAULT_ROLES,
BUILD_ROLES) — extending to more catalogs is mechanical; the picker is
the new substrate.

### Cross-role peer review (role-diff)
**Idea:** each role reviews ANOTHER role's output before synthesis.
Surfaces blind spots.

**Why deferred:** needs a per-role pairing scheme + a review prompt
+ runner orchestration of the review pass. Probably 1 day.

### Cross-worker handoffs (OW)
**Idea:** worker A discovers something worker B should investigate;
lead routes the handoff mid-run.

**Why deferred:** workers currently fire in parallel with no inter-
worker channel. Handoff needs mid-cycle pause + re-dispatch logic
that doesn't exist today.

### Multi-attempt baseline parallel (baseline)
**Idea:** 3 baseline attempts in parallel, vote on top result. Cheap
upgrade for the eval scoreboard.

**Why deferred:** needs a parallel-runner harness — today
BaselineRunner is single-shot. The voting logic + winner selection is
new substrate.

### Convergence-too-fast detector (council)
**Idea:** if R2 has zero KEEP→CHANGE, fire a forced-contrarian round
(one agent must dissent based on grounded evidence). Prevents
premature consensus.

**Why deferred:** needs a per-round flip-rate metric + a contrarian-
prompt mode. T173's steelman + confidence work covers part of this;
the contrarian round is the next layer.

### Stigmergy → blackboard chain
**Idea:** stigmergy's pheromone trails identify hot files; auto-fire a
blackboard run that targets them. T2.3's chain hint already lays
foundation; this would auto-launch.

**Why deferred:** the auto-launch path is the same risk class as
generic forward chain — needs orchestrator-level wiring + recursion
guards.

---

## Recommended next-session priority

If picking ONE thing to ship next:

1. **Dynamic role catalog (role-diff)** — biggest user-facing win;
   moderate effort. The current "same 7 roles for every directive"
   is the most visible mismatch in role-diff today.
2. **Test-driven todo expansion (blackboard)** — most impactful
   quality lever for the only write-capable preset; needs the test-
   scaffolding piece but pays off on every run.
3. **Smart slicing by import graph (map-reduce + stigmergy)** —
   foundational piece that unblocks two presets at once. Build the
   parser once, both consume.

Anything else here is opportunistic — wait for a real run that
visibly demonstrates the gap before investing.
