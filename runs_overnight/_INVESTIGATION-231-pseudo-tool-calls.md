# #231 Investigation — why models emit XML pseudo-tool-call markers

## Root cause

The blackboard planner uses opencode agent profile `"swarm-read"` (defined in
`RepoService.ts:312`), which has `read / grep / glob / list` tools enabled.

When opencode forwards a session.prompt to the AI SDK with these tools enabled,
the AI SDK injects the tool definitions into the model's system prompt. The
model is supposed to invoke them via OpenAI-compatible structured `tool_calls`.

**Bug**: glm-5.1 / nemotron-3-super / gemma4 don't properly emit OpenAI-style
structured tool_calls. Instead they emit XML-style text markers:

```
<read path='src/supervisor.ts' start_line='1' end_line='100'>
<grep path='src/' pattern='retry|backoff'>
<list>src/</list>
```

These markers are JUST TEXT — opencode never executes them. The planner is
literally hallucinating file reads. Then it produces a contract+todos based
on:

- Real grounding: `seed.readmeExcerpt` (4000 char README slice) + `seed.repoFiles` (top-level file list) — supplied via the user prompt at `buildFirstPassContractUserPrompt`.
- Hallucinated grounding: whatever the model imagines based on its training data + the file paths it pretended to read.

**Failure mode** (preset 1 + bonus 10): when the model decides to spend its
entire response on hallucinated reads instead of producing the JSON envelope,
parser fails with "Unexpected token '<'" → repair prompt → repair also emits
markers → no-progress.

## Why discussion presets don't hit this

Council, debate-judge, role-diff, mapreduce, stigmergy, round-robin all
ALSO use `swarm-read` per Unit 20, but they don't strictly parse JSON
envelopes — their output is prose synthesis. So even when the model emits
markers + prose mixed together, the prose is still useful as a transcript.

## Fix candidates

### Option A — Switch planner to `swarm` profile (no tools)

**Mechanism**: blackboard planner.contract pass + planner.todos pass + auditor + replanner change agentName from `"swarm-read"` to `"swarm"`. Opencode no longer injects tool definitions into the system prompt → model has nothing to "call" → no marker hallucinations.

**Trade-off**: loses the *intent* of the planner being able to inspect the repo. But that intent was already broken — the markers never executed. Actually no behavioral change beyond cleaner JSON output.

**Effort**: ~5 lines changed in BlackboardRunner.

**Risk**: low. Worst case the planner produces less informed contracts (which it was already producing).

### Option B — Implement a server-side text-marker interpreter

**Mechanism**: when an agent response contains `<read path='X'>` markers, pre-execute them server-side (using fs.readFile), append the results back to the same session, and re-prompt the model. Effectively makes the markers REAL tool calls.

**Trade-off**: significant work — needs a parser, an executor, a session continuation loop, error handling, depth limits. The opencode SDK probably already does this for proper structured tool_calls but not for text-style ones.

**Effort**: ~1-2 days.

**Risk**: medium-high. More moving parts, more edge cases.

### Option C — Use a model that supports tools properly

**Mechanism**: switch default planner from glm-5.1 to llama3.1 / qwen2.5 (which support OpenAI-style structured tool_calls).

**Trade-off**: regress to a different model + cost-curve. Behavior may differ on other axes.

**Effort**: ~2 lines (default model swap).

**Risk**: low for the marker issue specifically, but introduces other unknown behaviors.

## Recommendation

**Go with Option A.** The "swarm-read" agent profile was added (Unit 20) on the
assumption that tool-grants would let the model dynamically inspect the code.
That assumption is broken for the models we use — the inspection was always
hallucinated. Removing the tool grant for the planner is just removing a
fiction that costs us parse failures.

Implementation:
1. BlackboardRunner.runFirstPassContract → use agentName="swarm"
2. BlackboardRunner.runPlanner (todos pass) → use agentName="swarm"
3. BlackboardRunner.runAuditor → use agentName="swarm"
4. BlackboardRunner.runReplanner → use agentName="swarm"
5. Stretch: same change in OW-deep's orchestrator path
6. Document: comment in RepoService.ts explaining why swarm-read exists but blackboard's planner doesn't use it

Discussion presets keep using swarm-read because the marker hallucinations
don't break them. If they want real tools, that's a separate concern (Option B).
