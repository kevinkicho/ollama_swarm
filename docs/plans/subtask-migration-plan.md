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

## Next session — concrete first move

Don't refactor a runner. Instead: **run the smoke with two DIFFERENT
agents** (e.g., parent=`swarm-orchestrator`, child=`swarm-read`) inside
a real clone directory so our opencode.json is loaded. That isolates
whether the "no `<task_result>` wrapper" finding is universal or
specific to same-agent parent+child collapse. If the wrapper appears
when agents differ → option 3 might work. If it doesn't → we're stuck
with options 1 or 2.

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
