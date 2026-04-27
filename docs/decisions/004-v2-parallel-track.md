# ADR 004 — V2 substrate ships parallel-track, not big-bang cutover

**Status:** accepted (in active enforcement; ratchet ongoing)
**Decided:** 2026-04-26 (V2 work began)
**Last verified:** 2026-04-27

## Decision

Every V2 substrate ships behind a flag, runs *alongside* the V1
implementation, and is validated for divergence before V1 is deleted.
Concretely:

- `RunStateObserver` is wired into `BlackboardRunner` and `v2State`
  ships in `RunSummary`, but no consumer treats it as authoritative.
- `TodoQueueV2` mirrors V1 board events; `v2QueueState` ships in
  `RunSummary` for parity comparison.
- `WorkerPipelineV2` is gated by `USE_WORKER_PIPELINE_V2=1`. Default
  off. When on, `executeWorkerTodoV2` runs *instead of* V1's
  `executeWorkerTodo` for that one todo, but the surrounding
  Board.ts plumbing is still V1.
- `OllamaClient` (direct path) is gated by `USE_OLLAMA_DIRECT=1`.
  Default off. Only `BlackboardRunner` consults it; the other 7
  runners still always go through opencode.
- `EventLogReaderV2` ships read-only at `/api/v2/event-log`. The
  live UI still derives state from WebSocket snapshots, not the
  JSONL stream.

Each V2 piece earns its V1 deletion by surviving N stable runs with
0 divergences (see ADR-mentioned thresholds in `active-work.md`).

## Context

The V2 rewrite is large enough — state machine + queue + worker
pipeline + ollama-direct + event log + UI cutover — that a big-bang
swap would mean weeks of "this branch is broken, don't merge."
Worse, validating it would mean fully replacing the V1 path with no
fallback if a regression surfaces mid-validation.

Two prior incidents shaped this approach:
- The `streamPrompt` stale-idle bug (commit `18a7749`) — would not
  have been caught without a working V1 path running alongside.
- The `OLLAMA_BASE_URL` /v1 omission (commit `bb0c509`) — surfaced
  during preset-tour validation; if the only path were V2, we'd
  have blamed V2 for an unrelated bug.

## Alternatives considered

1. **Big-bang cutover.** Rewrite all of `BlackboardRunner` against
   V2 substrates, ship in one commit, rely on test coverage. Faster
   to "done" but high blast radius — any regression takes the
   blackboard preset offline until rolled back.

2. **Feature-branch development.** Develop V2 in a long-lived
   branch, merge when complete. Keeps `main` green but means weeks
   of merge-conflict toil and no incremental shipping. Doesn't
   actually reduce risk — the cutover commit is still big-bang from
   `main`'s perspective.

3. **Parallel-track behind flags (this ADR).** Each substrate ships
   to `main` immediately, default-off. Validation happens by toggling
   the flag on a single run and comparing V1 vs V2 outputs. Once a
   substrate has N stable runs with 0 divergences, V1 deletion is a
   small, scoped commit.

## Trade-offs

- **Cost:** every V2 substrate adds code that runs alongside V1.
  Both implementations have to be kept correct during the parallel
  window. Today: ~330 LOC of V1 Board.ts + ~140 LOC of V1 worker
  path + V2 substrates running in mirror — extra surface area.
- **Cost:** observers and mirrors aren't free at runtime. The V2
  state observer fires `checkPhase` on every `setPhase` call;
  `TodoQueueV2.onBoardEvent` runs on every board mutation. Cheap,
  but non-zero.
- **Win:** reversibility. If V2 has a regression mid-run, set the
  flag back to 0 and the system is V1-only again. No code change
  needed.
- **Win:** divergence surfaces empirically, not in code review.
  When `v2State.phase` disagrees with the V1 phase getter, that's
  a real bug we'd have shipped under big-bang.

## When to revisit

- When the last V2 substrate is default-on for 2+ stable runs with
  0 divergences, the parallel tracks collapse into V2-only and this
  ADR is obsolete.
- If the substrate count grows past ~6, the parallel-track overhead
  may justify a different rollout strategy (e.g. canary by repo).

## References

- `server/src/swarm/blackboard/RunStateObserver.ts` — parallel-track
  state observer
- `server/src/swarm/blackboard/TodoQueueV2.ts` — board-event mirror
- `server/src/swarm/blackboard/WorkerPipelineV2.ts` — V2 worker
  path, behind `USE_WORKER_PIPELINE_V2`
- `docs/active-work.md` — "Risky cutovers (need stable validation
  first)" section lists the V1-deletion triggers
- `docs/ARCHITECTURE-V2.md` — full V2 spec + integration status
