# Swarm Pattern Catalog

Design notes for the agentic-swarm patterns in `ollama_swarm`.

All major patterns are now shipped as selectable presets (12 total). The focus has shifted from "add more presets" to **Brain-as-OS integration** (using patterns for self-improvement runs, proposal generation, and concurrent orchestration) and robustness of concurrent execution.

Status legend (historical):
- `[x]` shipped as a preset
- Many "Unit X" references below are internal historical tracking from early 2026 development.

See `STATUS.md` for the current preset matrix and `active-work.md` for Brain-related work.

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

> Note: "Unit X" numbers and early development notes in this file are historical. Current implementation status is in STATUS.md.

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

### 6. Evaluator / critic loops `[~]` ← **shipped as a layer, not a standalone preset**
Worker produces → critic scores against a rubric → worker revises. Reflexion-style.

**Shipped layers (orthogonal — they bolt on to any preset):**
- `cfg.criticAtCommit` (Unit 35) — peer agent reviews each blackboard worker diff before commit; reject marks the todo stale.
- `cfg.councilReconcile: "vote"` — drafters cast a per-round ballot for the best OTHER draft (council).
- Debate-judge's verdict pass IS the evaluator step (built-in to the preset).
- `cfg.dynamicModelRoute` lets a "judgement" tier (auditor/judge/planner) route to a stronger model so the critic IS literally a more-capable judge.

**Wins:** polishes individual outputs to a quality bar.
**Limits:** scales by adding **iterations**, not agents. Orthogonal to
the "more agents" axis — and that's how it shipped: no standalone "critic" preset, just opt-in critic layers on the existing presets.

### 7. Blackboard architecture `[x]` ← **shipped (v1 preset)**
Instead of a linear transcript, agents post `claim`, `question`, `todo`,
`finding` items to a shared board. Any idle agent can pick up any unresolved
item. Async by design, no turn-taking.

Shipped layers: optimistic CAS on file hashes + small atomic units (≤2
files per commit) + planner/worker split + stale-replan on CAS rejection
+ hard caps (wall-clock / commits / todos) + `summary.json` run artifact.
See [`archive/blackboard-changelog.md`](./archive/blackboard-changelog.md)
for what landed in each commit (archived; `git log` is the live source);
[`../server/src/swarm/blackboard/ARCHITECTURE.md`](../server/src/swarm/blackboard/ARCHITECTURE.md)
is the architecture-as-shipped reference.

**Wins:** scales until the board gets too noisy to manage. No idle agents
waiting their turn. Natural fit for 10+ agents.
**Limits:** needs careful coordination rules (see sub-patterns below) —
without them, concurrent edits stomp each other and stale plans ship.

### 8. Stigmergy / pheromone trails `[x]` — shipped as `stigmergy` preset
Self-organizing repo exploration. No planner, no role assignment. Each
agent per turn reads the shared annotation table (file → `{visits,
avgInterest, avgConfidence, latestNote}`), picks one file to inspect
based on it, returns a structured annotation, and the runner updates
the table before the next agent's turn.

Shipped via `StigmergyRunner` (see
`server/src/swarm/StigmergyRunner.ts`) as a **standalone preset** for
repo exploration. A blackboard-layer variant exists for stigmergy-on-blackboard use.
via `cfg.stigmergyOnBlackboard`: when set, blackboard's `runWorker`
dispatch picks pending todos via `dequeueByScore` with a stigmergy bias
(`-touched` count of expectedFiles) so the swarm spreads commits across
the repo rather than dogpiling one hot-spot.

The annotation table is in-memory in the runner (wiped on next start).
Per round, agents go in index order; each sees the latest table, picks
a file, reads it, returns JSON `{file, interest: 0-10, confidence:
0-10, note}`. The runner clamps interest/confidence to [0, 10] so a
confused model can't poison the table with extremes. Running averages
per file accumulate across visits. `rounds` = exploration passes
through agents; total turns = rounds × agentCount.

**Wins:** zero-coordinator scaling, emergent coverage, pheromone trail
visible in the transcript (users can see *why* agents picked what
they picked).
**Limits:** harder to steer toward a specific goal; mostly useful for
survey/exploration phases, less so for directed work. No re-visit cap
— an agent might re-read the same file if the table suggests it's
still high-interest.

### 9. Mixture of Agents (MoA) `[x]` ← **shipped as `moa` preset (2026-05-01, three layers)**
Layer 1: N peer-hidden proposers (parallel) each draft an answer.
Layer 2: 1 aggregator reads all N drafts + synthesizes ONE final answer.
Crystal-clear "open-weights ensemble beats one big paid model" claim
when models differ per layer (`cfg.moaProposerModel` + `cfg.moaAggregatorModel`).

Shipped layers:
- Multi-tier aggregation tree via `cfg.moaAggregationLevels` (K → ceil(K/2) → ... → 1).
- Heterogeneous models per layer (small fast proposers + big synthesis aggregator).
- T-Item-2 (2026-05-04): K parallel debate streams via the same
  per-layer parallelism applied to debate-judge — different
  propositions run concurrently, judge synthesizes across.
- T-Item-MoaTools (2026-05-04): proposers can opt into read-only
  tools via `cfg.moaProposerTools`.

**Wins:** the project's headline claim — multiple small open-weights
models in parallel ≈ one big paid model at a fraction of cost.
**Limits:** discussion-only (proposers + aggregator return prose, not
file edits). For code-modify tasks, the verdict is "use blackboard."

### 10. Baseline `[x]` ← **shipped as `baseline` preset**
Single agent, single prompt, single apply step. The "thinnest honest baseline"
the eval harness compares every other preset against. T-Item-1 (2026-05-04)
added `cfg.baselineAttempts > 1` parallel-clone-to-K-subdirs harness:
K independent attempts in K clone subdirs; winner-pick by
`hunks_applied + 5×verify_passed - 3×verify_failed`; promote the
winner's clone to canonical path.

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
