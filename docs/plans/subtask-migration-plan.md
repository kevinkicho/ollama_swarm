# SubtaskPartInput migration plan (#235)

> **2026-04-28 update — smoke test finding:** the naive SubtaskPartInput
> approach doesn't give the structured output I'd assumed. **See "Smoke
> test result" section at the bottom.** This plan should NOT be executed
> as drafted; needs revision before any runner refactor.

## Why

Today: each agent has its own opencode subprocess + session. Multi-agent
runners (Council/OW/OW-Deep/MapReduce) orchestrate N parallel
`session.prompt` calls themselves.

Hypothesis: parent runs ONE session, includes `{ type: "subtask", agent,
prompt, description }` parts in its prompt body. opencode auto-dispatches
each subtask via `TaskTool` to a child session linked by `parentID`.
Subtask results return inline in the parent's response wrapped as
`<task_result>...</task_result>`.

## Smoke test result (2026-04-28)

Ran `/tmp/subtask-smoke.mjs` against a fresh `opencode serve` on
v1.14.28. Sent `parts: [{type:"subtask", description, prompt, agent}, {type:"text", ...}]` to `/session/{id}/message`.

**What worked:**
- ✅ status 200 — opencode ACCEPTED the part type without rejecting
- ✅ The subtask's prompt did execute (response "Hello" matched the
  subtask's `prompt: "Reply with the single word: hello"`)
- ✅ Confirmed our `swarm-orchestrator` profile is needed in
  opencode.json — when standalone (no clone dir), opencode reported
  `Agent not found: swarm-orchestrator. Available agents: build, explore,
  general, plan`. Within a clone with our config, the agent resolves.

**What DIDN'T work as planned:**
- ❌ Response had only THREE parts: `step-start`, `text`, `step-finish`
- ❌ NO `<task_result>` wrapper in any text content
- ❌ NO `subtask` part in the response (the subtask's output collapsed
  into the parent's `text` part)

Full response saved at `runs_overnight9/subtask-smoke-output.json`.

## What this means

The `<task_result>` wrapping in opencode source applies specifically to
**model-emitted `task` tool calls** — i.e., when the LLM decides at
runtime to invoke TaskTool. SubtaskPartInput is a different code path
where the CALLER pre-supplies the subtask intent in the prompt body. The
two paths share some plumbing (per opencode source's `handleSubtask`
function) but the output shape differs:

- **Model-emitted task tool**: result wrapped in `<task_result>...</task_result>` so the model can see the result inline and continue.
- **Caller-emitted SubtaskPartInput**: subtask runs but its output collapses into the parent's text without explicit demarcation (at least when parent + child use the same agent, as our smoke did).

## Why this matters for runner refactors

The MapReduce migration plan below assumed I could parse N
`<task_result>` blocks from the parent's response to recover per-mapper
outputs. **That doesn't work as drafted.** Without distinct delimiters,
N parallel mapper outputs collapse into one merged blob in the parent's
text — losing the per-mapper boundaries the runner needs for stats,
transcript display, and per-agent attribution.

## Revised approach options

1. **Use the model to emit `task` tool calls explicitly.**
   - Parent agent's prompt: "For each of these N subtasks, invoke the
     `task` tool with the given args."
   - Model emits N `task` tool_calls; opencode dispatches each; results
     come back as `<task_result>` blocks the model sees + can synthesize.
   - Trade-off: depends on the model reliably emitting structured tool
     calls — same risk as the XML-marker hallucination we fought (#231).
     glm-5.1 / nemotron-3-super likely fail this; would need a tool-
     capable model like qwen2.5 / llama3.1 / claude-*.

2. **Keep N separate `session.prompt` calls (status quo).**
   - Each subtask gets its own session.prompt → its own response → clean
     per-subtask output.
   - This is what we already do; the refactor would just rename it.

3. **Use SubtaskPartInput but structure the parent prompt to ask the
   model to delimit its synthesis explicitly.**
   - "Run these N subtasks, then for each one report `--- result N ---`
     followed by the subtask's output."
   - Fragile (model has to reliably delimit), but closer to the wire
     ergonomics SubtaskPartInput offers.

4. **PR opencode upstream to add structured subtask output in the
   response.**
   - Make opencode add a `subtask` part type to the response that
     wraps each subtask's result with metadata.
   - Right long-term but slow; depends on upstream merge.

None of these is "ship the migration tonight" — each needs design,
prototyping, and live validation. The smoke test demonstrates the
foundation works at the wire-format level but the output ergonomics
need more thought before runner refactors.

## Foundation already shipped (commits this overnight)

- `shared/src/subtaskPart.ts` — typed `subtaskPart()` builder + `extractSubtaskResults()` parser. 9 unit tests pass.
- `swarm-orchestrator` agent profile in `RepoService.writeOpencodeConfig` — same read perms as `swarm-read` plus `task: "allow"`. Used as the parent agent for subtask dispatch.
- `swarm-builder` profile (#237) — separate concern, allows bash for build-style TODOs.
- `/tmp/subtask-smoke.mjs` — captures the wire-shape result documented above.

## Smoke 2 result (2026-04-28, scripts/subtask-smoke2.mjs)

Re-ran smoke with parent=`swarm-orchestrator`, child=`swarm-read`,
inside a real clone dir so our `opencode.json` was loaded. Sent 2
subtask parts + 1 text "summarize" part. Inspected BOTH the immediate
prompt response AND the full `session.messages` list afterward.

**What we learned:**

- ✅ **Subtasks DO produce structured output** — but as separate
  MESSAGES with `parentID` linking back to the parent prompt. Not
  as parts on the parent's response. Querying GET
  `/session/{id}/message` after the prompt returns the parent message
  PLUS one assistant message per subtask, agent-tagged.

- ✅ **Child agent identity is preserved** — message[1] in our smoke
  had `agent: "swarm-read"` (the subtask agent), distinct from the
  parent's `agent: "swarm-orchestrator"`. So per-subtask attribution
  IS recoverable.

- ✅ **Parent synthesizes across subtask outputs** — the parent's
  final text part was: `"SUMMARY: I saw 51 entries in src/ and 3 in
  scripts/."` Real numbers from real subtask executions. The pattern
  works end-to-end.

- ❌ **Subtasks run SEQUENTIALLY, not in parallel.** 2 subtasks took
  ~66s total. Per-subtask wall clock is ~30s. Single-subtask call
  would be ~30s; 2 in parallel would be ~30s. 2 sequential = ~60s.
  Matches our observation.

  This is a genuine regression vs. the current `Promise.allSettled`
  pattern in MapReduce/Council/OW. With N mappers, sequential dispatch
  would be N× slower wall clock. For N=4 that's ~4 min instead of
  ~1 min per cycle.

## Updated cost/benefit for the runner migration

| Aspect | Status quo (N parallel session.prompts) | SubtaskPartInput (sequential) |
|---|---|---|
| Wall clock for N mappers | ~T (parallel) | ~N×T (sequential) |
| Per-agent stats / transcript | Clean — separate sessions | Recoverable via session.messages |
| Subprocess count | N opencode subprocesses | 1 parent + N transient child sessions |
| Code complexity | Manual fan-out + collect | One prompt + one messages query |
| Native opencode parent/child | None | Yes (parentID linkage) |
| Cancellation semantics | N session.abort calls | Probably 1 abort cancels all? (untested) |

**The migration loses parallelism.** That's the new dominant trade-off.
For runners where parallelism matters (MapReduce — N mappers exploring
in parallel was the WHOLE POINT) the migration is a regression.

## Revised recommendation

**Don't migrate** MapReduce / Council / OW / OW-Deep wholesale. Their
parallelism IS the architectural benefit. Switching to sequential
SubtaskPartInput would erase that.

Instead, keep #235 OPEN as a documented capability + foundation
(subtaskPart helper + swarm-orchestrator profile + this smoke
characterization) and use SubtaskPartInput in places where SEQUENTIAL
dispatch is appropriate:

- **Future: nested orchestrator-style subagents** that genuinely don't
  benefit from parallelism (e.g., a planner that wants to delegate
  one inspection-and-report subtask cleanly within its own prompt).
- **Future: smaller helper subagents** within a primary agent's
  workflow (e.g., a code reviewer that wants a one-off doc-lookup
  subtask).

Both of those are NEW patterns — not migrations of existing parallel
runners.

## Next session — concrete actions (not "migrate the runners")

1. Verify subtask parallelism via opencode source. If a config flag
   exists to opt into parallel dispatch (or there's a roadmap item
   for it), the calculus could change later.
2. Document the SubtaskPartInput helper as an "advanced/sequential"
   primitive in our internal API surface. Don't deprecate it; just
   don't push it as the migration target.
3. Close #235 as "investigated, foundation shipped, full migration
   not warranted given the parallelism trade-off." Re-open if upstream
   adds parallel dispatch.

## (Original plan, kept for reference but DON'T execute as-is)

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

(File-by-file blueprint preserved below — but DON'T execute until the
output-shape question above is answered.)
