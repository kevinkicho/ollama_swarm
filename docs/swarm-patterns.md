# Swarm Pattern Catalog

Design notes for the agentic-swarm patterns we plan to support in `ollama_swarm`.
The long-term goal: expose each pattern as a selectable **preset** on the setup
page (next to repo URL / agent count) so a user can run the same repo through
different patterns and compare outcomes side-by-side.

Status legend:
- `[ ]` not started
- `[~]` in progress
- `[x]` shipped as a selectable preset
- `[=]` currently the only mode (pre-preset era, will be replaced or folded into a preset)

---

## Current implementation (pre-preset)

`[=]` **Round-robin shared-transcript.** N identical agents, one SSE-driven turn
each per round, full transcript injected into every prompt. Lives in
`server/src/services/Orchestrator.ts`. Works but suffers from echo-chamber
behavior — each agent sees the previous replies before speaking, so later
agents converge on earlier positions.

---

## Pattern catalog

### 1. Role differentiation `[x]` ← **shipped as `role-diff` preset (Unit 8)**
Same weights, different system prompts. Assign each agent a role —
architect, tester, security-reviewer, performance-critic, docs-reader,
dependency-auditor, devil's-advocate. Identical models with distinct priors
produce genuinely different takes. This is MetaGPT's core insight and what
AutoGen calls "conversable agents."

Shipped as an option on `RoundRobinRunner` (see `server/src/swarm/roles.ts`
for the seven-role catalog). The `role-diff` preset instantiates the same
runner with `DEFAULT_ROLES` injected; plain `round-robin` still exists as
the no-role baseline for comparison. Transcript labels agents with their
role so peer @mentions and re-reads stay legible.

**Wins:** cheap diversity, no architectural change.
**Limits:** still single-threaded; roles are declared not earned.

### 2. Map-reduce over the repo `[x]` ← **shipped as `map-reduce` preset (Unit 14)**
Agent 1 is the REDUCER; agents 2..N are MAPPERS. The runner
round-robins the top-level repo entries across mappers — each mapper
gets a fixed slice and inspects ONLY that slice (no shared transcript,
no peer reports visible during map phase). Reducer then sees all
mapper reports and synthesizes.

Shipped via `MapReduceRunner` (see
`server/src/swarm/MapReduceRunner.ts`). Slicing is mechanical
(`sliceRoundRobin` partition — every entry appears in exactly one
slice, lengths differ by at most 1), not LLM-decided. That's
deliberate: the lesson from the MatSci run (see Unit 11) was that
LLM planners can get lazy and under-dispatch. A mechanical partition
side-steps that failure mode entirely — the only way a mapper can
skip coverage is if it refuses its slice outright, which would show
up as a visibly empty report.

`rounds` = number of map-reduce cycles. Cycle 1 is broad coverage;
cycle 2+ lets the reducer re-issue mappers on the SAME slices to
deepen or re-verify. (Re-slicing between cycles is a future extension
if we ever want "fill this specific gap the last reducer identified.")

**Wins:** embarrassingly parallel, scales linearly with agent count,
coverage is guaranteed (no LLM laziness gap), each mapper's prompt is
small because it only sees its slice.
**Limits:** no cross-pollination during exploration; reducer becomes
the bottleneck and the single point of failure; slicing by top-level
entry is coarse (a large `src/` dir all goes to one mapper).

### 3. Council / parallel drafts + reconcile `[x]` ← **shipped as `council` preset (Unit 10)**
Round 1: every agent answers the question **without** seeing others'
replies. Round 2+: all drafts are revealed, agents revise.
The independent Round 1 is where the real diversity lives.

Shipped via `CouncilRunner` (see `server/src/swarm/CouncilRunner.ts`).
Implementation: `loop()` snapshots the transcript at round start, fans
out all agents in parallel via `Promise.allSettled`, and each agent's
prompt is built from the pre-round snapshot — so even if one agent's
`session.prompt` returns before another's, no agent in the same round
can ever see a peer's draft. `buildCouncilPrompt` (exported for tests)
filters `role === "agent"` entries out of the visible transcript when
`round === 1`. No reconcile policy in v1 — agents revise freely across
later rounds with no voting or synthesis step. Discussion-only.

**Reference:** Du et al., "Improving Factuality and Reasoning in Language
Models through Multiagent Debate" (MIT, 2023).
**Wins:** directly fixes the echo chamber that plagues round-robin.
**Limits:** 2x the calls vs round-robin, no explicit reconcile step
(so convergence is implicit — the user reads the final round).

### 4. Orchestrator–worker hierarchy `[x]` ← **shipped as `orchestrator-worker` preset (Unit 12)**
Agent 1 is the LEAD: it produces a plan (`{assignments: [{agentIndex,
subtask}]}`), workers execute their subtask in parallel with no peer
visibility, then the lead synthesizes. `rounds` = plan → execute →
synthesize cycles.

Shipped via `OrchestratorWorkerRunner` (see
`server/src/swarm/OrchestratorWorkerRunner.ts`). Workers see only their
assigned subtask + the seed system messages — not the lead's planning
text, not peer worker reports. The lead sees the full transcript on its
planning and synthesis turns. `parsePlan` strips any assignment whose
`agentIndex` isn't in the worker set (no self-assignment to the lead; no
assignment to a worker that didn't spawn) and drops duplicates.

**V1 scope note.** No model heterogeneity yet — the lead and workers all
use `cfg.model`. The canonical orchestrator-worker win is "stronger
planner model + cheaper worker model" (Opus→Sonnet/Haiku); that's a
Unit-13+ optional add when we have a concrete need.

**Wins:** directed division of labor. Coverage is controlled, not
emergent. Output has a synthesizer by design (no "user reads and
reconciles in their head" like Council requires).
**Limits:** lead is a bottleneck; plan quality caps output quality.

### 5. Debate + judge `[x]` ← **shipped as `debate-judge` preset (Unit 13)**
Fixed 3 agents. Agent 1 = PRO (argues FOR the proposition), Agent 2 =
CON (argues AGAINST), Agent 3 = JUDGE (silent until the final round,
then reads the whole debate and scores: PRO WINS / CON WINS / TIE with
confidence LOW/MEDIUM/HIGH).

Shipped via `DebateJudgeRunner` (see
`server/src/swarm/DebateJudgeRunner.ts`). Per round Pro speaks first,
then Con — both seeing the full running transcript so they can rebut
(the Council-style round-1 isolation would defeat the point of a
debate). On the final round, Judge goes last. Proposition defaults to
*"This project is ready for production use."*; users override by using
the inject-message field *before* starting the run — the most recent
pre-start user injection is picked up as the proposition override.
Mid-run injections post to the transcript as normal commentary.

**Wins:** better truth signal than consensus, since agreement is often
just conformity. Good for yes/no or A-vs-B decisions.
**Limits:** fits only framable decisions; not a general discussion
pattern. Fixed at exactly 3 agents (Pro/Con/Judge) — no other
configuration makes sense.

### 6. Evaluator / critic loops `[ ]`
Worker produces → critic scores against a rubric → worker revises. Reflexion-style.

**Wins:** polishes individual outputs to a quality bar.
**Limits:** scales by adding **iterations**, not agents. Orthogonal to
the "more agents" axis; probably layers on top of any other pattern.

### 7. Blackboard architecture `[x]` ← **shipped (v1 preset)**
Instead of a linear transcript, agents post `claim`, `question`, `todo`,
`finding` items to a shared board. Any idle agent can pick up any unresolved
item. Async by design, no turn-taking.

Shipped layers: optimistic CAS on file hashes + small atomic units (≤2
files per commit) + planner/worker split + stale-replan on CAS rejection
+ hard caps (wall-clock / commits / todos) + `summary.json` run artifact.
See [`blackboard-plan.md`](./blackboard-plan.md) for phase-by-phase notes
and [`blackboard-changelog.md`](./blackboard-changelog.md) for what
landed in each commit.

**Wins:** scales until the board gets too noisy to manage. No idle agents
waiting their turn. Natural fit for 10+ agents.
**Limits:** needs careful coordination rules (see sub-patterns below) —
without them, concurrent edits stomp each other and stale plans ship.

### 8. Stigmergy / pheromone trails `[ ]`
Agents leave annotations on files they've explored with a
confidence/interest score. Other agents prefer unexplored or contentious
files. Natural for repo exploration — agents self-organize who covers
what without a central planner.

**Wins:** zero-coordinator scaling, emergent coverage.
**Limits:** harder to steer toward a specific goal; mostly useful for
survey/exploration phases, less so for directed work.

---

## Blackboard coordination sub-patterns

When agents pull from a shared board, overlap and stale plans are the core
problems. These are the layers we can stack onto the blackboard:

- **Pessimistic file claims.** Agent declares intended files at claim time;
  board rejects overlapping claims. Simple, but head-of-line blocks on shared
  utility files.

- **Optimistic + CAS + re-plan.** ← **chosen layer**
  Agents record file hashes at claim time, work freely, and at commit-time
  the board rejects any commit where a touched file changed underneath them.
  Rejected todos go back on the board flagged `stale_since=<sha>` and are
  re-planned before being reclaimable. Mirrors database MVCC and `git rebase`.

- **Dependency-graph scheduling.** A planner pass builds a DAG of todos by
  file overlap; overlapping todos are serialized, disjoint ones parallelize.
  Re-runs on every completion. Strong guarantees; needs a smart planner.

- **Git-branch per agent + merge-agent.** Each worker runs in its own branch;
  a maintainer agent rebases/merges completed branches into main. Reuses
  git's battle-tested merge logic. Costs a working copy per agent and
  makes the maintainer a bottleneck at scale.

- **Small atomic units + continuous re-planning.** ← **chosen layer**
  Todos are tiny ("extract function X from file Y"). After each commit the
  planner sweeps and regenerates remaining todos from current code state.
  Staleness barely exists because no plan lives long enough to go stale.
  Closest thing to stigmergic behavior.

The **chosen stack for v1 of the blackboard preset** is optimistic+CAS
(lets workers parallelize without blocking) layered over small atomic units
(keeps the re-plan cost bounded and the conflict surface tiny).

---

## Implementation roadmap

| # | Preset                       | Coordination                        | Why this order |
| - | ---------------------------- | ----------------------------------- | -------------- |
| 1 | Blackboard ✓ shipped         | Optimistic+CAS + small atomic units | User's pick; biggest architectural lift, do it while context is fresh |
| 2 | Role differentiation ✓ shipped | n/a (single-turn loop)            | Cheap; good comparison baseline against blackboard |
| 3 | Map-reduce ✓ shipped         | n/a (split + synthesize)            | Tests whether isolation beats shared context for coverage |
| 4 | Council (parallel + reconcile) ✓ shipped | n/a (round-based)         | Isolates diversity gain from role-prompting gain |
| 5 | Orchestrator–worker ✓ shipped | n/a                                | Needs role differentiation to be useful; builds on #2 |
| 6 | Debate + judge ✓ shipped     | n/a                                 | Narrow use case; wait until we have a concrete yes/no question |
| 7 | Critic loops                 | Layer, not preset                   | Orthogonal — add as a toggle on any preset |
| 8 | Stigmergy                    | Layer on blackboard                 | Extends #1; file-annotation scoring on top of the board |

---

## Preset-picker UX sketch (for later)

The setup page today takes `repoUrl`, `localPath`, `agentCount`, `rounds`,
`model`. The preset picker adds one field: **Pattern**, a dropdown with
per-preset help text.

Pattern-specific knobs should only appear for the selected preset:
- Role differentiation → a list of role slots (editable)
- Map-reduce → tree-slicing strategy (by folder / by file-type / custom)
- Council → round count + reconcile policy (vote / merge / judge)
- Orchestrator-worker → lead model override
- Blackboard → max concurrent agents, stale-retry limit, atomic-unit size cap

Keep `agentCount` meaningful across all presets; it caps the number of
concurrent worker slots regardless of pattern.

---

## Open questions to revisit

- **Persistence.** The blackboard wants to survive a server restart (so
  in-flight claims aren't orphaned). Current transcript is in-memory only
  — do we need SQLite, or is per-run JSON on disk enough?
- **Cross-preset transcript format.** The UI currently assumes one linear
  transcript. Blackboard wants a board view; map-reduce wants a tree view.
  We'll need a generic "event" stream and per-preset renderers.
- **Metrics.** To actually compare presets, we need to record wall-clock,
  token usage, and some output-quality proxy (LOC changed? tests passing?).
  Worth thinking about before we ship preset #2.
