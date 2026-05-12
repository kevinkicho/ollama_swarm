# Known Limitations

Deliberate trade-offs in the current build. Each entry names the choice, why
we made it, and what would force us to revisit. Anything that becomes a
*real* problem in practice should graduate out of here into a plan item.

---

## Blackboard planner now uses `swarm-read` (resolved 2026-05-09)

**Previous state:** Blackboard's planner and auditor used `swarm` profile (tools
disabled). The planner produced contracts with zero file inspection — working
only from the seed context, unable to read/grep/glob the actual repo.

**Current state:** Planner, auditor, and contract builder now use `"swarm-read"`
profile (read/grep/glob/list tools enabled). The planner prompt explicitly
instructs tool use: "You have `read`, `grep`, `glob`, `list` tools on the
cloned repo. USE THEM before emitting TODOs." Workers remain on `"swarm"` —
they must return JSON diffs, not call tools directly. A 3-file read limit
per planning turn prevents context blow-up.

**Files:** `plannerRunner.ts:81`, `auditorRunner.ts:105`, `contractBuilder.ts`
(`"swarm-read"` agent profile) · `prompts/planner.ts:262` (TOOLS section) ·
`prompts/firstPassContract.ts:162` (tool instruction)

---

## Discussion presets now have opt-in write capability (Phase 1 — 2026-05-04)

**Previous limitation:** All discussion presets (round-robin, council, MoA, 
map-reduce, etc.) were read-only. They could analyze and synthesize but 
couldn't modify the cloned repo.

**Current state:** All discussion presets now support `cfg.writeMode: "single"`
which enables a write phase after discussion completes. The synthesizer 
(lead/aggregator/reducer/judge) produces hunks directly using the 
`synthesizerHunks.ts` infrastructure.

**What's still deferred (Phase 2+):**
- `writeMode: "multi"` — each agent proposing hunks during their turn
- Coordinated writes across N agents (conflict detection, reconciliation)
- Preset-specific multi-writer strategies

**When this would need revisiting:** When users want true parallel writes
(multiple agents editing simultaneously) rather than single-writer 
post-discussion synthesis.

---

## Planner does double duty as the replanner

**Choice:** when a todo goes stale, the **planner agent** handles the replan.
We do not spawn a dedicated replanner agent.

**Why:** the planner already has the repo context loaded and a system prompt
that understands the todo shape. Reusing it keeps agent count stable and
token usage low.

**When this would need revisiting:**
- If we want the replanner to run on a different model or with different parameters.
- If the planner's system prompt needs to specialize so hard in one direction that it starts producing worse replans.
- If we hit token-budget pressure where sharing one agent's context across planning and replanning causes context bloat.

Until any of those bite, one agent covers both roles.

---

## Multi-tenant token attribution — resolved (2026-05-09)

`tokenTracker` now supports per-runId attribution. `UsageRecord` carries a
`runId` field, `totalsInWindow` filters by runId, and `/api/usage?runId=X`
returns per-run aggregates. Concurrent runs can report per-run token totals.
The remaining edge case: interleaved `tokenTracker.add()` calls may capture
the timestamp at insertion time rather than request time — the run-window
filter is approximate for very short runs.

---

## MoaRunner does not use base class spawn/prompt pipeline

**Choice:** MoaRunner re-implements clone+spawn and the prompt pipeline in
`loopBody()` and `runOne()` instead of using `initCloneAndSpawn()` and
`runDiscussionAgent()` from `DiscussionRunnerBase`. This is the only
subclass that diverges from the base pipeline.

**Why:** MoA needs heterogeneous model selection (different models for
proposers vs aggregators, per-proposer model cycling). The base
`initCloneAndSpawn` assumes one model for all agents. The base
`runDiscussionAgent` routes through `promptWithFailoverAuto` with full
observability wiring; MoA's simplified pipeline skips this for throughput.
The divergence is structural, not accidental — normalizing it would require
extending the base class to support per-agent model overrides and optional
observability wiring, which adds complexity to every other runner for the
benefit of one.

**Revisit when:** MoA becomes a primary preset (currently beta), or when the
maintenance burden of the divergence (bug fixes applied to 2 pipelines
instead of 1) exceeds the cost of extending the base class.

---

## Region status dashboard is deferred

**Choice:** No 5-region run-status dashboard (lifecycle / planner / workers /
queue / caps). The statechart analysis confirmed 5 orthogonal regions exist
but they're collapsed into a single "Running" badge in the UI.

**Why:** 4 hours to build + 2 hours/year to maintain for an audience of 1.
The same data is accessible via `boardCounts()`, `anyAgentThinking()`, and
`isPaused()` — they're just not rendered in one place. The `regions` field
on `SwarmStatus` is already plumbed through the API (2026-05-09) so the
data pipeline exists for anyone who wants to build a dashboard.

**Revisit when:** the project has >1 active user, or a CI pipeline needs
run-status visibility, or staleness debugging time exceeds 2 hours/month.

---

## Local GPU breakeven is theoretical at current cloud prices

**Choice:** Local Ollama hardware has no economic case at current Ollama Cloud
prices ($0.02/M tokens). A $3,000 GPU amortized over 36 months costs
$83/month — breakeven requires 5,197 run-pairs/month (173/day). Even at
CI-scale sweep volumes, cloud is currently cheaper.

**Why this isn't the full story:** Cloud inflation at 10%/year halves the
breakeven by year 3. 2x token growth (planner gets file-reading tools,
longer prompts) halves it again. Latency savings are 54 hours/year at 1
run/day (gemma4 12s cloud vs <1s local). The LCCA analysis (2026-05-09)
shows local is the correct 3-year strategic bet even though cloud wins on
present-day economics.

**Revisit when:** Ollama Cloud prices increase, or latency becomes the
binding constraint for experiment velocity.