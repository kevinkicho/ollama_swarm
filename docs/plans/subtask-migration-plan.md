# SubtaskPartInput migration plan (#235)

> Concrete, file-by-file blueprint for migrating our 4 multi-agent
> runners off the N-subprocess + N-session model onto opencode v2's
> native `SubtaskPartInput` (one parent session that dispatches
> subtasks via the `task` tool).

## Why

Today: each agent has its own opencode subprocess + session. Multi-agent
runners (Council/OW/OW-Deep/MapReduce) orchestrate N parallel
`session.prompt` calls themselves.

With v2: parent runs ONE session, includes `{ type: "subtask", agent,
prompt, description }` parts in its prompt body. opencode auto-dispatches
each subtask via `TaskTool` to a child session linked by `parentID`.
Subtask results return inline in the parent's response wrapped as
`<task_result>...</task_result>`.

Wins:
- Native parent/child relationship (better UI, logging, cancellation)
- Less subprocess overhead (1 parent + N short-lived child sessions
  instead of N long-lived subprocesses)
- Aligns with the queued "drop opencode subprocess" work in
  `docs/active-work.md`

Risks:
- **Per-agent stats** — today we track tokens/turns per subprocess; with
  subtasks all roll up to the parent. Need to either accept loss of
  granularity OR have opencode emit per-subtask token deltas (unverified).
- **Failure semantics** — what happens when a subtask fails mid-prompt?
  Does the parent prompt abort, or does the parent get an error
  `<task_result>` and continue? Unverified.
- **Concurrency model** — does opencode dispatch multiple subtask parts
  in parallel or sequentially? Source uses `yield*` (sequential
  generator pattern); needs runtime confirmation.
- **Context isolation** — subtasks get isolated child sessions; parent's
  message history doesn't leak (verified from source). But parent system
  prompt — does it inherit? Unverified.

## Foundation already shipped (commit covering #235 base)

- `shared/src/subtaskPart.ts` — typed `subtaskPart()` builder + `extractSubtaskResults()` parser. 9 unit tests pass.
- `swarm-orchestrator` agent profile in `RepoService.writeOpencodeConfig` — same read perms as `swarm-read` plus `task: "allow"`. Used as the parent agent for subtask dispatch.

## Spike strategy

Migrate runners in order of complexity (simplest first). RUN each one
against a live opencode instance after migration to validate runtime
behavior. Don't migrate the next one until the previous validates.

### Order:
1. **MapReduceRunner** — simplest pattern (N mappers + 1 reducer). Spike here.
2. **OrchestratorWorkerRunner** — flat lead+workers. Has subtle worker context isolation.
3. **CouncilRunner** — N drafters, round 1 isolation requirement is non-trivial under subtask model.
4. **OrchestratorWorkerDeepRunner** — 3-tier topology, most complex.

### Out of scope:
- StigmergyRunner — sequential turn-by-turn, no parallel dispatch pattern.
- DebateJudgeRunner — sequential PRO/CON/JUDGE rotation, no parallel dispatch.
- RoundRobinRunner — sequential by definition.
- BlackboardRunner — different architecture (planner+workers via blackboard, not direct dispatch). Migration would also touch the V2 worker pipeline which is mid-cutover.

## MapReduceRunner spike (the proof-of-concept)

### Today's flow (`server/src/swarm/MapReduceRunner.ts`)

```
spawnAgent x N → mappers spawn 1..N
spawnAgent → reducer (agent 1)
loop {
  // Map phase
  Promise.allSettled([
    mapper2.session.prompt({ ... slice 2 ... }),
    mapper3.session.prompt({ ... slice 3 ... }),
    ...
  ])
  // Reduce phase
  reducer.session.prompt({ ... synthesize all mapper outputs ... })
}
```

### After migration

```
spawnAgent → reducer (agent 1) — only ONE subprocess needed
loop {
  // Map + reduce in ONE prompt to the reducer
  reducer.session.prompt({
    sessionID, agent: "swarm-orchestrator",
    parts: [
      subtaskPart({ description: "map slice 2", prompt: "...", agent: "swarm-read" }),
      subtaskPart({ description: "map slice 3", prompt: "...", agent: "swarm-read" }),
      ...
      { type: "text", text: "Now synthesize the above subtask outputs into a single reducer summary." },
    ],
  })
  // Parse <task_result> blocks via extractSubtaskResults() to get
  // per-mapper outputs for the transcript display.
}
```

### Files to modify

- `server/src/swarm/MapReduceRunner.ts` — gut the parallel-prompt loop, replace with single-parent-session-with-subtask-parts. Update mapperSlices tracking. Re-derive per-mapper agent indices from subtask result order.
- `server/src/services/AgentManager.ts` — no change strictly needed (we'd just not spawn the mapper subprocesses), but should add a way to NOT spawn N agents for runners that use subtasks. Could be a flag on the runner or a different code path. Probably: pass `agentCount: 1` for the reducer-only runners post-migration.
- `server/src/swarm/MapReduceRunner.test.ts` (if exists) — update to match new shape.

### Validation
1. Restart dev server (so v2 SDK + new opencode.json + #235 foundation are live)
2. Run map-reduce preset against multi-agent-orchestrator with a real directive
3. Verify in transcript: should see ONE agent-1 entry per cycle that contains the synthesized text + `<task_result>` blocks visible in the raw response
4. Verify in summary.json: 1 agent in agents[] (the reducer), not N

### Open questions surfaced during spike
- Does opencode parallelize multiple subtask parts in one prompt, or run them sequentially? (matters for token-budget pacing)
- Do per-subtask token deltas surface in the SSE stream, or only get rolled up to the parent's totals?
- What happens on subtask failure — abort the parent, or get an error `<task_result>` and continue?

## Other runners (after MapReduce validates)

### CouncilRunner
- Parent: agent-1 as `swarm-orchestrator` per round
- Round 1: dispatch N subtask parts (one per drafter), each with `agent: "swarm-read"` and a prompt that's just the seed (no peer drafts visible — natural since subtasks have isolated context)
- Round 2+: same dispatch but include prior round's drafts in each subtask prompt (visibility per design)
- Synthesis: continue with same parent session
- Per-round subtask dispatch + isolation is naturally enforced by opencode's child-session model

### OrchestratorWorkerRunner
- Parent: agent-1 as `swarm-orchestrator`
- Cycle: parent emits a plan + N subtask parts (one per worker subtask), each with `agent: "swarm-read"`
- Synthesis: parent's text continuation after the subtask parts
- Reports per worker map to per `<task_result>` block in parent's response

### OrchestratorWorkerDeepRunner
- 3-tier: top orchestrator dispatches K mid-lead subtasks; each mid-lead subtask itself dispatches its workers as nested subtasks
- Need to verify opencode supports nested `task` invocations (one subtask spawning more subtasks via the same `task` tool)
- Probably yes since each subtask is a regular session that can invoke any tool granted to its agent profile (would need `swarm-orchestrator` permission for mid-leads)

### Migration cost summary

| Runner | LOC est. | Risk |
|---|---|---|
| MapReduceRunner | ~150 | medium (spike target) |
| OrchestratorWorkerRunner | ~180 | medium |
| CouncilRunner | ~220 | high (Round 1 isolation needs careful prompt construction) |
| OrchestratorWorkerDeepRunner | ~300 | very high (nested subtasks unverified) |

Total: ~850 LOC of careful work. Plus per-runner validation runs. Estimate: 2-3 focused days.
