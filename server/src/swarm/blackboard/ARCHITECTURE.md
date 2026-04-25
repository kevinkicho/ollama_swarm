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

`BlackboardRunner.workerPipeline()` (around line 2270) is the heart
of the runner. Each worker turn flows through this single function:

1. **Read expectedFiles** → hash them now, stash as `hashes`.
2. **Build worker prompt** with seed + todo + (anchored context if
   `expectedAnchors` set, Unit 44b).
3. **Prompt worker** → response is a JSON envelope of hunks.
4. **Parse + repair** — one repair attempt if JSON-invalid (Task #67
   tracks `jsonRepairs` per agent).
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
2. **First todo batch** (`runPlanner`) — posts initial todos.
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
   before posting the todo. Drop-on-mismatch with a finding.
3. **Smaller batches (#71)** — `MAX_TODOS_PER_BATCH = 5` (was 20).
   Replanner re-prompts per batch; smaller batches give the planner
   feedback (decline / repair / commit) sooner.

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
| `hunk apply failed: search text not found` | Worker's search anchor doesn't exactly match file (often whitespace) | Open: would benefit from fuzzy-match (suggested follow-up). |
| `worker output has leading UTF-8 BOM` | Rare; some models emit BOM | Detected + rejected. |
| `critic rejected (...)` | Critic flagged busywork | Opt-in via `cfg.critic`. |
| `auto-skipped: replan attempts exhausted (3)` | Replanner couldn't make the todo workable | `MAX_REPLANS_PER_TODO` constant; not currently configurable. |

## File map

```
BlackboardRunner.ts        # The 3500-line god class. Most logic here.
Board.ts                   # In-memory todo/claim/finding store + events.
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
