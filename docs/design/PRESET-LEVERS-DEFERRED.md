# Per-preset levers — status snapshot

> Last refresh: 2026-05-04 (T192-T198 closed all remaining items as
> functional thin-cuts; full production polish for several items is
> still deferred — see "Quality bar" section below).

## All 44 brainstormed items — closed

| Preset | # | Status |
|---|---|---|
| **Blackboard** | 1 Test-driven todo expansion | ✅ T198h thin-cut (planner verifies via `verify:` clause; no test scaffolding gen) |
| | 2 Specialized worker roles | ✅ pre-T171 (Unit 59 stub) |
| | 3 Auditor "partial" → parallel hypothesis | ✅ T198i thin-cut (planner emits 2-3 alternatives sequentially; not in-flight parallel) |
| | 4 Code-context preloading at first wave | ✅ T188 |
| | 5 Adaptive worker pool sizing | ✅ T198c thin-cut (LOG-ONLY watchdog; doesn't actually spawn/kill agents yet) |
| **Round-robin** | 1 Disposition-tuned models | ✅ T193 (modelOverride + cfg.dispositionModels) |
| | 2 Cross-round disagreement surfacing | ✅ T172 |
| | 3 Convergence-aware termination | ✅ pre-T171 (improvement #3) |
| | 4 Disposition voted next | ✅ T185 |
| **Role-diff** | 1 Dynamic role catalog | ✅ T198b thin-cut (keyword-table prepends specialists; not LLM-driven role picking) |
| | 2 Cross-role peer review | ✅ T186 |
| | 3 Role-pair conflicts | ✅ T186 |
| | 4 Role-specific tool grants | ✅ T194 (Tester/Security/DepAuditor → swarm-builder) |
| **Map-reduce** | 1 Smart slicing by import graph | ✅ T197 thin-cut (TS/JS regex extractor; cross-language deferred) |
| | 2 Mapper specialization | ✅ T174 |
| | 3 Streaming reducer | ✅ T198a thin-cut (half-batch synchronous split, not chunk streaming) |
| | 4 Reducer re-tasking | ✅ T190+T192 (prompt + runner-side dispatch) |
| **Council** | 1 Forced steelmanning | ✅ T173 |
| | 2 External grounding requirement | ✅ T181 |
| | 3 Convergence-too-fast detector | ✅ T181 |
| | 4 Per-position-confidence weighting | ✅ T173 |
| **OW (flat)** | 1 Worker output rubric | ✅ T175 |
| | 2 Cross-worker handoffs | ✅ T195 (HANDOFF lines + mini-wave dispatch) |
| | 3 Subtask effort estimates | ✅ T182 |
| | 4 Lead-decomposition peer review | ✅ T182 |
| **OW-Deep** | 1 Per-tier model tiering | ✅ T196 substrate (UI surface still deferred) |
| | 2 Bi-directional refinement | ✅ T198f thin-cut (pushback prompt + log; no auto-replan) |
| | 3 Tier-skipping for trivial subtasks | ✅ T192 |
| | 4 Mid-lead clustering | ✅ T183 |
| **Debate-judge** | 1 Verifiable implementer nextAction | ✅ T176 (wrap-up apply + verifyCommand) |
| | 2 Opposing-evidence rounds | ✅ T184 |
| | 3 Loser-perspective preservation | ✅ T176 |
| | 4 Parallel proposition derivation | ✅ T198d thin-cut (3 candidate propositions; one debate, not 3 parallel) |
| **Stigmergy** | 1 Pheromone semantics (typed) | ✅ T177 |
| | 2 Cross-cluster discovery via import graph | ✅ T197 (high-interest annotation → soft bumps on related files) |
| | 3 Pheromone evaporation | ✅ pre-T171 (improvement #5) |
| | 4 Stigmergy → blackboard chain | ✅ T187 (chain hint) + T192 (auto-launch via cfg.chainTo) |
| **MoA** | 1 Heterogeneous proposers UI surface | ✅ T196 substrate (cfg.moaProposerModels array; UI form picker deferred) |
| | 2 Proposer specialization via system prompts | ✅ T178 |
| | 3 Two-stage aggregation | ✅ T198e (top-aggregator synthesizes the K mid-syntheses when twoStageMoA + K>=2) |
| | 4 Aggregator confidence → another round | ✅ T189 |
| **Baseline** | 1 Self-critique pass | ✅ T179+T192 (prompt + runner wiring) |
| | 2 Repo-context preloading | ✅ T179+T192 (recentCommits + collectRecentCommits) |
| | 3 Multi-attempt baseline parallel | ✅ T198g substrate (cfg.baselineAttempts logged; sequential dispatch deferred — needs parallel-runner harness) |

---

## Quality bar — what's "thin-cut" vs production-ready

**Production-ready (full quality):** T172-T179, T181-T191, T192-T196.
These shipped with prompt + runner-side wiring + tests. Default off
or backward-compat; opt-in flags ship for behavioral changes.

**Thin-cut (functional but limited):** T197 (TS/JS only — no Python/
Rust/Go), T198a (half-batch, not true streaming), T198b (keyword table,
not LLM-driven), T198c (log-only, no actual spawn/kill), T198d (one
debate not three parallel), T198e (single top-aggregator pass),
T198f (pushback log-only, no auto-replan), T198g (logs intent only,
runs single attempt), T198h (no test-scaffolding generator), T198i
(sequential alternatives, not in-flight parallel).

Each thin-cut has the cfg flag + the runner-side hook + clear caveat
comments. Real production-quality follow-ups are days each, listed below.

---

## Real-quality follow-ups (deferred, days each)

### Multi-language import graph (T197 → real)
**Estimate:** 3-5 days.
**Substrate:** ts-morph (TypeScript), babel (JS), tree-sitter or LSP
client for Python/Rust/Go. Need a per-language parser registry +
unified ImportGraph output type. T197's regex extractor stays as
the TS/JS fallback when AST parser fails.

### Real streaming reducer (T198a → real)
**Estimate:** 2-3 days.
**Substrate:** rework MapReduceRunner to fire reducer at each mapper
return (Promise.race + state machine), not at fixed batch boundaries.
Reducer prompt must handle cumulative + delta inputs.

### LLM-driven dynamic role catalog (T198b → real)
**Estimate:** 1-2 days.
**Substrate:** new prompt — planner reads directive + emits role
catalog as JSON before discussion starts. Role-shape validation
(don't accept "Generic Helper" → must be specific). Replace the
keyword table.

### Real adaptive worker pool (T198c → real)
**Estimate:** 3-5 days.
**Substrate:** AgentManager dynamic spawn during a run + lifecycle
accounting + cost attribution. The watchdog already exists from
T198c; the spawn/teardown is the missing piece.

### Parallel proposition debates (T198d → real)
**Estimate:** 2-3 days.
**Substrate:** runner harness for K parallel debate streams. Each
debate has its own transcript scope; judge cross-evaluates after.

### Multi-stage MoA aggregation full tree (T198e → real)
**Estimate:** 1-2 days.
**Substrate:** generalize the two-stage tree to N levels. Add cfg.
moaTopAggregatorModel (top tier may want different model than mids).

### Bi-directional OW-Deep auto-replan (T198f → real)
**Estimate:** 2-3 days.
**Substrate:** orchestrator-level replanning protocol. When N
mid-leads pushback, orchestrator re-decomposes + dispatches a new
plan. Bounded retry cap.

### Parallel multi-attempt baseline (T198g → real)
**Estimate:** 1-2 days.
**Substrate:** clone-to-K-subdirs harness + parallel runner +
voting on applied-hunks count + commit the winner. Needs disk
isolation per attempt.

### Test-scaffolding generator (T198h → real)
**Estimate:** 3-5 days per language.
**Substrate:** generate a failing test from the directive, write
to disk, pass to verify gate. JS/TS via vitest first; cross-language
follows. Trickiest part: identifying the right test file location
and the right assertion shape.

### In-flight parallel hypothesis (T198i → real)
**Estimate:** 3-4 days.
**Substrate:** worker pool can run 2-3 alternative todos simultaneously
against the same criterion; cross-cancellation when one lands; auditor
re-evaluates after each.

### Per-tier model UI surfaces (T196 → real)
**Estimate:** 2-3 days.
**Substrate:** SetupForm components — per-disposition picker for
round-robin, per-tier picker for OW-Deep, per-proposer picker for
MoA. Substrate (cfg fields) already shipped in T196 + T193; this
is purely frontend work.

---

## Recommended next-session priority

If picking ONE thing to ship next, the value-prop demo plays first:

1. **Per-tier model UI surfaces** — substrate already shipped; just
   needs SetupForm components. The most visible demo of the open-
   weights-parallelism thesis. ~2-3 days.
2. **LLM-driven dynamic role catalog** — replace the keyword table
   with a planner pass. Biggest user-facing win for role-diff today.
   ~1-2 days.
3. **Multi-language import graph** — unblocks 2 presets (map-reduce
   smart slicing + stigmergy cross-cluster) for non-TS/JS repos.
   ~3-5 days.

Anything else here is opportunistic — wait for a real run that
visibly demonstrates the gap before investing.
