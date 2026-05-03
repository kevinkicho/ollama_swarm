# Per-preset levers — deferred to follow-up sessions

> Living doc tracking which preset improvements have shipped vs which
> remain. Updated 2026-05-04 (T191) after a second pass that closed
> 10 more items beyond the original T171-T180 set. Heavy substrate
> items are still parked here for future session pickup with effort
> estimates.

## What's shipped (cumulative)

### T171-T180 (first pass, 2026-05-04 morning)

| Task | Preset | Lever |
|---|---|---|
| T171 | cross-cutting | Verify-gated wrap-up apply (cfg.verifyCommand honored by maybeRunWrapUpApply) |
| T172 | round-robin | Cross-round flips section in synthesis |
| T173 | council | Forced steelmanning in R2+ + per-position confidence weighting |
| T174 | map-reduce | Mapper specialization (lens-per-mapper) |
| T175 | OW (flat) | Per-subtask successCriteria rubric + worker self-eval |
| T176 | debate-judge | Loser-perspective preservation + canonical wrap-up apply |
| T177 | stigmergy | Typed pheromones |
| T178 | MoA | 3 new proposer biases + aggregator confidence parser |
| T179 | baseline | Recent commit context + structured self-critique pass |

### T181-T190 (second pass, 2026-05-04 afternoon)

| Task | Preset | Lever |
|---|---|---|
| T181 | council | External grounding requirement (every MY POSITION cites a file/test) + R2-zero-flip → contrarian-round trigger |
| T182 | OW (flat) | Per-subtask effort estimates (small/medium/large) + decomposition peer review (sibling agent flags issues before workers fire) |
| T183 | OW-Deep | Mid-lead clustering of worker outputs into themes BEFORE escalating + tier-skip option for trivial subtasks |
| T184 | debate-judge | Opposing-evidence rounds — every turn must include a `## Evidence` block citing real code/tests |
| T185 | round-robin | NEXT-DISPOSITION VOTE — agents propose what lens is needed next; runner picks majority vote (falls back to mechanical rotation) |
| T186 | role-diff | Cross-role peer review (R2+) + role-pair conflicts (synthesis explicitly resolves Performance↔Security, Architect↔Implementer, etc.) |
| T187 | stigmergy | Hot-files chain section — top-K by pheromone score becomes the blackboard chain target text |
| T188 | blackboard | Code-context preloading — pre-fetched file excerpts (via gatherProposerContext) injected into the planner's first-wave prompt |
| T189 | MoA | Aggregator confidence override — CONFIDENCE: low + remaining rounds → forces another round (was just parsed in T178; now wired to behavior) |
| T190 | map-reduce | Reducer re-tasking — `RE-TASK: Mapper N | new-framing: …` lines surface intent (runner-side dispatch deferred) |

All shipped levers are opt-in or backward-compatible. Default behavior
of every preset is unchanged unless a new cfg flag is set.

---

## Shipped earlier (already in tree before this initiative)

- Round-robin convergence-aware termination (improvement #3, semantic-similarity stop after R2+)
- Stigmergy pheromone evaporation (improvement #5, decay-aware ranking)
- Council per-position confidence weighting (T173)
- Map-reduce mapper specialization (T174)
- Debate-judge implementer/reviewer/signoff phase (Task #102, prose-only)
- Blackboard specializedWorkers stub (cfg.specializedWorkers, surfaced in PresetExtras)
- MoA per-aggregator variant rotation (balanced/clarity/actionability)

---

## Deferred — heavy substrate (days each)

### Smart slicing by import graph (map-reduce + stigmergy)
**Idea:** group files that import each other into the same mapper
slice (map-reduce) AND plant pheromones along import edges when an
explorer surfaces a finding (stigmergy cross-cluster discovery). Both
need the same import-graph parser.

**Why heavy:** needs an import-graph parser (ts-morph or babel for TS,
ast-grep for cross-language). Has to handle aliased imports, dynamic
imports, re-exports. ~2-3 days for a TS-only first cut, plus another
day to handle Python/JS.

**When to do this:** after a real run where round-robin slicing
visibly hurt synthesis quality. Until then T174's lens specialization
covers most of the gap.

### Test-driven todo expansion (blackboard)
**Idea:** planner proposes a failing test FIRST, worker makes it
pass; verify gate confirms. "Did the worker do something" → "did they
make a measurable thing change."

**Why heavy:** test-scaffolding is language-specific. JS/TS via
vitest/jest with simple assert patterns is doable; cross-language is
substantial. Also needs planner-prompt + auditor-prompt restructuring.
~3-5 days.

### Auditor "partial" → parallel hypothesis (blackboard)
**Idea:** when auditor verdict is "partial," split unmet criterion
into 2-3 alternative todos and run them in parallel; pick whichever
lands first.

**Why heavy:** auditor needs to emit structured alternatives (today
emits prose); runner needs to manage in-flight competing todos with
cross-cancellation. ~3-4 days.

### Two-stage MoA aggregation
**Idea:** K mid-aggregators each synthesize a subset of proposers,
top aggregator synthesizes the K mid-syntheses. Beats single-
aggregator collapse on long contexts.

**Why heavy:** MoaRunner currently has K-aggregator parallel + central-
pick; this would be a new tree shape with proposer→mid-agg→top-agg.
~1-2 days for runner + new prompt builders.

### Bi-directional refinement (OW-Deep)
**Idea:** mid-leads can push back on the orchestrator's decomposition
(today strictly top-down).

**Why heavy:** needs a feedback channel + protocol for push-back +
re-decomposition. ~2-3 days.

### Adaptive worker pool sizing (blackboard)
**Idea:** scale workers based on todo backlog (more todos = more
workers; fewer when backlog drains).

**Why heavy:** AgentManager spawn/teardown is fire-and-forget at run
start. Dynamic spawn during a run needs careful lifecycle management
+ cost accounting. ~3 days.

### Multi-attempt baseline (parallel)
**Idea:** 3 baseline attempts in parallel, vote on top result.

**Why heavy:** needs a parallel-runner harness — today BaselineRunner
is single-shot. Voting + winner selection logic is new substrate.
~1-2 days.

### Parallel proposition derivation (debate-judge)
**Idea:** 3 candidate propositions, debates run in parallel, judge
picks the most informative.

**Why heavy:** triples the cost of every debate-judge run; needs N
parallel debate streams the runner has to manage; judge prompt has
to cross-evaluate. ~2-3 days.

---

## Deferred — moderate effort (1-2 sessions each)

### Dynamic role catalog (role-diff #1)
**Idea:** instead of fixed BUILD_ROLES vs DEFAULT_ROLES, planner reads
the directive and picks roles. "Refactor auth" → +Auth, +Security,
+Migration. "Speed up search" → +Performance, +Profiling, +Caching.

**Why deferred:** needs an LLM-driven role picker (prompt + parser)
OR a directive-keyword → role mapping. ~1-2 days.

### Role-specific tool grants (role-diff #4)
**Idea:** Tester gets bash to run tests, Documentarian gets readme-
template scaffolding, Security gets dep-graph queries.

**Why deferred:** needs per-role ToolDispatcher profiles + role→profile
routing in the runner. Today everyone uses `swarm-read`. ~1 day.

### Heterogeneous proposers UI surface (MoA #1)
**Idea:** per-proposer model picker exposed in the SetupForm (today
moaProposerModel takes only one model — same for all proposers).

**Why deferred:** UI work (form components for variable-N pickers).
~1 day. The substrate (per-call model override) already exists.

### Cross-worker handoffs (OW #2)
**Idea:** worker A discovers something worker B should investigate;
lead routes the handoff mid-run.

**Why deferred:** workers fire in parallel with no inter-worker
channel. Handoff needs mid-cycle pause + re-dispatch logic. ~2 days.

### Disposition-tuned models (round-robin #1)
**Idea:** Critic/Gap-finder routed to reasoning-tier; Builder/
Synthesizer routed to coding-tier.

**Why deferred:** needs per-disposition model field on RunConfig +
runner switching. ~0.5-1 day. Plays directly to the open-weights-
parallelism value prop — worth doing soon.

### Streaming reducer (map-reduce #3)
**Idea:** reducer doesn't wait for all mappers; synthesizes as
findings arrive.

**Why deferred:** needs reducer prompt that handles partial input +
runner orchestration of the streaming. ~1-2 days.

### Stigmergy → blackboard auto-launch (stigmergy #4 part 2)
**Idea:** instead of just a chain hint (T2.3 + T187), auto-fire the
blackboard run with the hot-files directive.

**Why deferred:** auto-launch needs orchestrator-level wiring +
recursion guards (same risk class as the original forward-chain MVP
deferred in T2.3).

### Per-tier model tiering UI (OW-Deep #1)
**Idea:** UI surface for orchestrator (reasoning) / mid-leads
(reasoning) / workers (coding) per-tier model picker.

**Why deferred:** UI work + form components. Substrate (per-agent
model overrides) already exists. ~1 day.

---

## Recommended next-session priority

If picking ONE thing to ship next:

1. **Disposition-tuned models (round-robin #1)** — small lift, plays
   directly to the open-weights-parallelism thesis. Can prove the
   value prop with one preset before scaling to OW-Deep + MoA.
2. **Dynamic role catalog (role-diff #1)** — biggest user-facing win
   for role-diff today; the "same 7 roles for every directive"
   mismatch is the most visible.
3. **Test-driven todo expansion (blackboard)** — most impactful
   quality lever for the only write-capable preset. Pairs with the
   verify gate already shipped (T171).
4. **Smart slicing by import graph (map-reduce + stigmergy)** —
   foundational substrate that unblocks two presets at once.

Anything else here is opportunistic — wait for a real run that
visibly demonstrates the gap before investing.
