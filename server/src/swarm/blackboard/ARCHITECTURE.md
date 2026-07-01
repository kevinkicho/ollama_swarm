# Blackboard preset — architecture

A decision-focused map of the blackboard runner. **Read this before
editing any file in `server/src/swarm/blackboard/`.** Code is the
source of truth — this doc explains *why* the code looks the way it
does, not *what* it does line-by-line.

## Mental model (one paragraph)

A **planner** (agent-1) inspects the cloned repo and posts small
**todos** to a shared **board**. **Workers** (agents 2..N) claim
todos, propose code edits as a JSON envelope of **hunks**, and commit
if optimistic-CAS on file hashes still passes. An **auditor** judges
the run against a per-run **exit contract** of criteria. The loop
terminates when the auditor signals all-met (optionally climbing an
**ambition tier**), or when a hard cap fires (wall-clock / commits /
todos), or when the user stops it.

## Agent topology

| Agent | Role | Notes |
|---|---|---|
| `agent-1` | planner + replanner + (auditor unless dedicated) | Single session — context continuity matters. **Don't rotate the planner role** (see `feedback_blackboard_planner_design.md`). |
| `agent-2..N` | workers | Race to claim todos. FCFS; no smart routing. |
| `agent-N+1` | dedicated auditor (opt-in, Unit 58) | Spawned only when `cfg.dedicatedAuditor === true`. Frees agent-1 from the planner-vs-auditor context-pressure tradeoff. |

Workers can be **specialized** (Unit 59) — each gets a different
role bias (correctness / simplicity / consistency) prepended to its
system prompt. Same model + same todo, different priors. Default off.

## Core data structures

- **Board** (`Board.ts`) — owns todos, claims, findings. Single
  source of truth for what's pending vs in-flight vs done. Emits
  events on every mutation (`todo_posted`, `todo_claimed`,
  `todo_committed`, `todo_stale`, `todo_skipped`, etc.).
- **Todo** — `{id, description, expectedFiles[], expectedAnchors?,
  expectedSymbols?, status, claim?, replanCount, ...}`. Lifecycle:
  `open → claimed → committed | stale → (replan) → ... → skipped`.
- **Claim** — `{todoId, agentId, fileHashes, claimedAt, expiresAt}`.
  `fileHashes` is the optimistic-CAS witness; the runner re-hashes
  at commit time and rejects if anything drifted under the worker.
- **ExitContract** — `{missionStatement, criteria[]}`. Each criterion
  has `{id, description, expectedFiles[], status: "unmet"|"met"|"wont-do"}`.
  Set once by the planner at first-pass-contract; the auditor
  promotes/demotes status on each audit pass.

## Worker pipeline (the commit critical path)

`BlackboardRunner.workerPipeline()` is the heart of the runner. Each worker turn flows through this single function:

1. **Read expectedFiles** → hash them now, stash as `hashes`.
2. **Build worker prompt** with seed + todo + (anchored context if
   `expectedAnchors` set, Unit 44b).
3. **Prompt worker** → response is a JSON envelope of hunks.
 4. **Parse cascade** — 4-tier: parse → repair → brain fallback → sibling-retry.
    Each tier catches a different failure class (see Parse Cascade section).
    Task #67 tracks `jsonRepairs` per agent in the first tier.
5. **Decline branch** — worker returned `{skip: "reason"}` →
   markStale with `worker declined: <reason>`.
6. **Empty hunks** → markStale (`empty hunks no skip reason`).
7. **Re-hash expectedFiles** → if any hash changed since `hashes`,
   markStale (`CAS mismatch before write`). Lost the race.
8. **applyHunks** — applies replace/create/append against pre-prompt
   contents. Failure → markStale (`hunk apply failed: <error>`).
9. **Validate** — zero-out check, BOM check.
10. **Critic intercept (Unit 35, opt-in)** — peer-agent reviews the
    diff. Reject → markStale. Critic ensemble (Unit 60, opt-in) is
    a 3-lane majority vote.
11. **Atomic write** — tmp + rename per file.
12. **Board.commitTodo** — record success.

Every stale-attributable-to-agent path increments
`rejectedAttemptsPerAgent` (Task #67) for the per-agent table.
Commit success increments `commitsPerAgent` + `linesAddedPerAgent` /
`linesRemovedPerAgent` (Task #66) via `countNewlines()` from each
hunk's text.

## Planner loop

Three planner invocations:

1. **First-pass contract** (`runFirstPassContract`) — once, after
   spawn + seed. Produces the ExitContract. May be skipped via
   `cfg.resumeContract` (Unit 57) which loads the prior run's contract
   from `blackboard-state.json`.
2. **First todo batch** (`runPlanner`) — posts initial todos. Includes
   a **redundancy check** (2026-05-17): before posting, verifies that
   `plausible-new` files don't already exist on disk. If every
   expectedFile is a plausible-new path that already exists (workers
   from prior tiers created them), the todo is dropped as redundant.
   This prevents the "32/32 skipped" failure mode where the planner
   proposes TODOs for files earlier workers already wrote.
3. **Replan** (`processReplanQueue`) — fires whenever a todo goes
   stale. Serialized through agent-1 (single session). After
   `MAX_REPLANS_PER_TODO = 3` replans, the runner auto-skips with
   `auto-skipped: replan attempts exhausted (3)`.

After workers drain the board, `runDrainAuditRepeat` (Phase 11c)
calls the auditor. If the auditor proposes new todos OR flips
criteria, post them and loop. If `auditInvocations` exceeds the cap
without new work, terminate with `completionDetail: auditor cap`.

## Termination

Three hard caps, whichever fires first:

- **Wall-clock** — default 8h, configurable via `cfg.wallClockCapMs`.
  Uses `accumulatedActiveMs` to be **host-sleep-proof** (Unit 27 —
  `Date.now() - startedAt` would falsely trip on a laptop suspend).
- **Commits** — 200 (hard-coded `WALL_CLOCK_CAP_MS`-style sibling).
- **Todos** — 300 total posted (not committed).

Plus terminal phases:
- **completed** — auditor signaled all-met OR drain-exit on no-work.
- **stopped** — user pressed Stop.
- **failed** — runner threw mid-loop.

`stopReason` + `stopDetail` land on the run summary so the modal
+ banner can explain WHY the run ended.

## Persistence

- **`<clone>/blackboard-state.json`** — debounced live snapshot of
  contract + tier + counters. Written every ~1s of activity (Unit 31).
  Survives crashes; used by `cfg.resumeContract` to skip first-pass
  contract on a re-run against the same clone.
- **`<clone>/summary.json`** — latest-run pointer.
- **`<clone>/summary-<iso>.json`** — per-run, never overwritten.
  Both contain the full RunSummary including persisted transcript
  (Task #65). Modal + review-mode load from these.

## Optional features (env / per-run)

| Feature | Knob | What it does |
|---|---|---|
| Council-style first-pass contract | `cfg.councilContract` or `COUNCIL_CONTRACT_ENABLED` | All N agents draft a contract independently, planner merges. |
| Critic | `cfg.critic` or `CRITIC_ENABLED` | Peer reviews each diff; reject → stale. |
| Critic ensemble | `cfg.criticEnsemble` | 3-lane vote (substance / regression / consistency). |
| Specialized workers | `cfg.specializedWorkers` | Per-worker role bias. |
| Dedicated auditor | `cfg.dedicatedAuditor` + `cfg.auditorModel` | Spawn agent N+1 just for audits. |
| Ambition ratchet | `cfg.ambitionTiers` | On all-met, re-plan a harder next contract; climb up to N tiers. |
| UI URL | `cfg.uiUrl` + `MCP_PLAYWRIGHT_ENABLED` | Auditor's swarm-ui agent navigates here + snapshots accessibility tree as evidence. |
| Resume | `cfg.resumeContract` | Reload prior contract + tier from `blackboard-state.json`. |

## Skip-reduction mechanisms (Tasks #69-71, 2026-04-25)

Three layers of defense against the most common failure mode (planner
generates todos premised on code that doesn't exist):

1. **Stronger planner prompt (#69)** — explicit `REQUIRED VERIFICATION`
   section telling the planner to grep before emitting an existing-
   symbol todo. Concrete example, names the failure mode, frames cost.
2. **expectedSymbols validation (#70)** — `checkExpectedSymbols()` does
   word-boundary grep of each declared symbol in each expectedFile
   before posting the todo. **Strips** hallucinated symbols rather than
   dropping the entire todo — a todo with valid `expectedFiles` but
   invalid `expectedSymbols` keeps its files and loses only the symbol
   references. Only todos whose `expectedFiles` fail file-grounding are
   dropped entirely.
3. **Smaller batches (#71)** — `MAX_TODOS_PER_BATCH = 5` (was 20).
   Replanner re-prompts per batch; smaller batches give the planner
   feedback (decline / repair / commit) sooner.
4. **Read-only todo suppression (rule 5a)** — The planner prompt
   hard-bans read-only TODOs ("read X", "analyze Y", "explore Z").
   Workers decline these and the replanner confirms the skip, wasting
   an entire cycle.

Combined effect measured in one blackboard run on multi-agent-
orchestrator: skip rate dropped from **60-80% → 12%**, commits
doubled (3-4 → 6) at the same wall-clock cap.

## Failure-mode catalog (where stale events come from)

When debugging "why did so many todos go stale," look here:

| Stale reason | Root cause | Fix surface |
|---|---|---|
| `worker declined: <reason>` | Worker correctly refused (symbol/file doesn't exist) | Pre-validate via expectedSymbols (Task #70 — partial) |
| `worker JSON invalid (...)` | Model produced malformed envelope | Repair-prompt path; one retry. Surfaces in `jsonRepairs` per-agent. |
| `worker produced invalid JSON after repair` | Repair also failed | Counted as `rejectedAttempts`. Often nemotron parser confusion. |
| `CAS mismatch before write` | Lost the race to another worker | Inherent to optimistic-CAS. Higher concurrency = more collisions. |
| `hunk apply failed: search text not found` | Worker's search anchor doesn't exactly match file (often whitespace) | Partial: trailing-whitespace normalization shipped 2026-05-09; content-drift anchors still fail. |
| `worker output has leading UTF-8 BOM` | Rare; some models emit BOM | Detected + rejected. |
| `critic rejected (...)` | Critic flagged busywork | Opt-in via `cfg.critic`. |
| `auto-skipped: replan attempts exhausted (3)` | Replanner couldn't make the todo workable | `MAX_REPLANS_PER_TODO` constant; not currently configurable. |

## Sibling-retry (model failover)

When the planner, contract builder, or auditor produces JSON that fails
parsing (even after repair), the runner retries once with a **sibling
model** before giving up. The sibling model is looked up via
`siblingModelFor()` in `BlackboardRunnerConstants.ts`, which maps each
primary model to a failover candidate (e.g. `nemotron-3-super → gemma4`).

Six retry paths (all using `withSiblingRetry()` from `siblingRetry.ts`):
| Trigger | Condition | File | Retry |
|---|---|---|---|
| Planner parse fail | JSON invalid after repair + brain | `plannerRunner.ts` | Re-run planner with sibling |
| Planner 0-grounded | All todos dropped by file/symbol grounding | `plannerRunner.ts` | Re-run planner with sibling |
| Planner empty | 0 valid todos produced | `plannerRunner.ts` | Re-run planner with sibling |
| Contract parse fail | JSON invalid after repair + brain | `contractBuilder.ts` | Re-run with sibling |
| Auditor parse fail | JSON invalid after repair attempt | `auditorRunner.ts` | Re-run audit with sibling |
| Worker parse fail | JSON invalid after repair + brain | `workerRunner.ts` | Re-prompt worker with sibling |

All five paths emit a `model_shift` WS event so the UI shows the
temporary model change. **Critical:** every path emits a **reverse**
`model_shift` in a `finally` block + calls `updateAgentModel(original)`
so the UI reverts to the primary model after the retry, whether it
succeeds or fails. Without this revert, the sidebar permanently shows
the fallback model.

Retry is limited to one level — the `isFallbackAttempt` flag prevents
recursive fallback. If the sibling model also fails, the run continues
with whatever partial output was produced (or an empty contract).

## Parse cascade (why 4 tiers?)

Every worker prompt output goes through a 4-tier cascade before being
accepted or rejected:

```
worker prompt → [parse] → [repair] → [brain] → [sibling] → commit
                 75% pass   60% pass   80% pass   55% pass
```

**Why 4 tiers?** The Monte Carlo analysis (2026-05-09) proved each tier
catches a different failure class:

| Tier | Catches | Fallback cost |
|------|---------|---------------|
| Parse | Valid JSON structure | <1ms (sync) |
| Repair | Format errors (malformed JSON, wrong field names) | +1 turn |
| Brain | Unparseable-but-extractable JSON (gemma4 extraction) | +0.3 turns (faster model) |
| Sibling | Model-specific failure modes (XML drift, empty responses) | +1 turn |

**Why not fewer tiers?** Removing repair causes trivial format errors to
cascade to sibling (which may fail the same way). Removing brain removes
the only tier that handles genuinely unparseable-but-structured output.
Removing sibling removes the long-tail rescue (~1% of todos).

**Why not more tiers?** Each additional tier has diminishing returns.
The sensitivity analysis showed brain improvement from 0.80→0.95 gains
only 0.3pp in overall success. The cascade is at an efficiency plateau.

**Sibling model mapping** (from `BlackboardRunnerConstants.ts`):

```
glm-5.1:cloud     ↔ deepseek-v4-flash:cloud  (mutual siblings)
deepseek-v4-pro   → deepseek-v4-flash:cloud  (one-way — deepseek unstable)
```

DeepSeek is never chosen as a sibling FOR any model — it's present only
as a target FROM deepseek (in case a user explicitly selects it).

**Cascade diagnostics** are available via `GET /api/swarm/runs/:id/stats`
which returns per-tier staleness and commit breakdowns.

## File map

```
BlackboardRunner.ts        # The 864-line orchestration class. Most logic extracted into 22 standalone modules.
Board.ts                   # In-memory todo/claim/finding store + events.
plannerRunner.ts           # Planner + replanner agent, including sibling-retry + redundant-TODO detection.
contractBuilder.ts         # First-pass contract builder, including sibling-retry.
auditorRunner.ts            # Auditor agent, including sibling-retry.
contextBuilders.ts          # Prompt/context assembly for all blackboard agents.
siblingRetry.ts             # Shared 6-path sibling-retry wrapper (withSiblingRetry).
applyHunks.ts              # Replace/create/append hunk application.
diffValidation.ts          # Zero-file + BOM checks.
caps.ts                    # Wall-clock + commits + todos hard caps.
crashSnapshot.ts           # Best-effort summary on uncaught throw.
finalAudit.ts              # Drain-audit-repeat helper.
resolveSafe.ts             # Path traversal guard for write paths.
retry.ts                   # Per-agent retry-budget tracker.
stateSnapshot.ts           # blackboard-state.json reader/writer.
summary.ts                 # RunSummary builder + types (incl. PerAgentStat).
transcriptSummary.ts       # Lenient JSON summarizer for worker_hunks tagging.
boardBroadcaster.ts        # WS event fan-out.
writeFileAtomic.ts         # tmp + rename helper.
BlackboardRunnerConstants.ts # Sibling-model lookup, max-replan limit, shared constants.
prompts/
  planner.ts               # PLANNER_SYSTEM_PROMPT + parsePlannerResponse.
  worker.ts                # Worker system prompt + parseWorkerResponse.
  critic.ts                # Single-critic prompt + verdict parser.
  auditor.ts               # Auditor prompt + verdict applier.
  contract.ts              # First-pass exit contract prompts.
```

## Things NOT to do (lessons learned)

- **Don't rotate the planner role across agents.** Single-session
  context continuity is what makes the planner's mental model of the
  codebase coherent across replans. See
  `feedback_blackboard_planner_design.md`.
- **Don't try to collapse 1-subprocess-per-agent into one process.**
  It's intentional isolation. See `feedback_data_before_theories.md`.
- **Don't widen `MAX_TODOS_PER_BATCH` back up.** Pre-#71 the planner
  generated 20 todos based on assumed code structure; smaller batches
  let it adapt to worker feedback.
- **Don't delete the `transcriptSummary.ts` slice-between-braces
  fallback.** Models occasionally append a stray `]` to JSON; without
  the fallback, summaries drop and the modal renders raw JSON.
- **Don't drop todos entirely when expectedSymbols fail.** Strip the
  hallucinated symbols and keep the todo with its valid expectedFiles.
  Production runs showed models hallucinate symbol references (functions
  that don't exist in the declared files); dropping the entire todo is
  worse than keeping it without symbols.
- **Don't forget to revert model_shift after sibling-retry.** If the
  retry path emits `model_shift` but the `finally` block doesn't emit
  a reverse shift, the UI permanently shows the fallback model. Always
  pair every `model_shift` with a revert in `finally`.
- **Don't broadcast agent states after `killAll` sets `killed=true`.**
  The `setAgentState` guard silently drops events when `killed=true`,
  so any late state transition after killAll is invisible to the UI.

## Layering verification (2026-05-09)

A UML package diagram analysis confirmed clean layering between the
blackboard subsystem and the rest of the swarm:
- Blackboard modules import from parent swarm utilities (`siblingRetry`,
  `promptRunner`, `loopGuards`, `runFinallyHooks`).
- Parent swarm modules do NOT import from blackboard internals.
- Zero circular dependencies across the 22 extracted modules.
- The V2 extraction successfully achieved textbook layered architecture.

## Stuck-cycle retry (autonomous runs)

When `rounds=0` (infinite/autonomous) and the auditor + planner fallback both
produce no new open todos — a "stuck cycle" — the run allows up to 3
consecutive stuck cycles before giving up. Each is logged as `"Stuck cycle
N/3 — re-trying in autonomous mode."` Non-autonomous (finite-round) runs
exit immediately on first stuck cycle. The counter resets on any successful
cycle. This prevents autonomous runs from burning tokens in futile replan
loops while still giving the planner a chance to recover from transient
planning failures.
