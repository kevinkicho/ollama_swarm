# #231 Investigation — FINAL: pseudo-tool-call markers ARE hallucinations

## Question (raised by Kevin during validation 4)

Are the `<read>/<grep>/<list>` markers we see in agent text actually
real SDK tool calls being executed (and we're just seeing their text
representation), or are they hallucinations the model emits because
it saw the format in training data?

## Answer: hallucinations. Four pieces of evidence.

### 1. Behavioral signature
Real tool calls return a result; the model sees the file content and
either stops emitting reads or continues with prose grounded in what it
learned. Hallucinated calls just spew — Kevin observed 182 marker
segments in a row in the live streaming dock during this run, never
once "stopping" to integrate a result. The model emits, gets nothing
back, emits another, repeat. Classic hallucination signature.

### 2. Removing tools IMPROVED output
Pre-#231: blackboard contract pass with `swarm-read` (tools enabled)
emitted dozens of markers prefixing the JSON envelope → parse failures.
Post-#231: contract pass with `swarm` (no tools) emitted clean
1293-char JSON envelope (entry 10 in run 61d59783), zero markers.

If markers were a useful tool-use signal, removing the tool grant would
DEGRADE output. Instead it improved. Conclusion: the markers were noise,
not signal.

### 3. SSE channel mismatch
opencode's structured tool calls flow through the AI SDK as `tool_call`
parts (separate from text parts). These markers arrive in the `text`
channel — meaning the AI SDK doesn't recognize them as tool invocations
and never executes them. They're just text the model wrote that happens
to look like XML.

### 4. Validation 4 success came from CONTRACT INJECTION, not from markers being executed
The fix that finally got blackboard producing real commits (`63b29ea`
follow-up 2) was injecting the user directive + just-produced contract
INTO the todos prompt. The model needed grounding from the prompt, not
from "tool reads". The 5 successful commits in run 61d59783 prove the
work happens via grounding, not via hallucinated tool execution.

## Why the model emits these markers

Likely training-data origin: glm-5.1 / nemotron-3-super / gemma4 saw
Anthropic-style `<read path='X' />` tool calls in their training corpus
(probably from logged Claude conversations). When asked to "use read /
grep / list tools" they generate the format they remember. opencode
passes OpenAI-format tool definitions to Ollama via @ai-sdk/openai-
compatible, but these models don't translate from the seen-in-training
XML to the OpenAI `tool_calls` JSON structured format. So the markers
go out as text and never become real invocations.

## Cascade fix shipped tonight

| Task | Commit | What it addresses |
|------|--------|-------------------|
| #229 | `372809e` | Server-side strip in `BlackboardRunner.appendAgent` (UI clean for finalized bubble) |
| #230 | `9b9b0c4` | Universal `stripAgentText` across remaining 6 runners |
| #231 base | `6248dfc` | `promptPlannerSafely` default `"swarm-read"` → `"swarm"` (contract pass) |
| #231 follow-up 2 | `63b29ea` | Inject userDirective + contract criteria into todos prompt |
| #231 follow-up 3 | `a025fac` | Council contract drafts also use `"swarm"` (no tools) |
| #231 follow-up 4 | `a9d356b` | Strip markers from LIVE streaming dock (was 182-segment overflow) |

## Validation 4 results

Run `61d59783`, blackboard, glm-5.1, multi-agent-orchestrator, fresh clone:
- ✅ Contract pass: clean 1293-char JSON, 5 criteria, no markers
- ✅ Todos pass: 5 valid todos posted (grounded in injected contract)
- ✅ All 5 todos committed by workers
- ✅ 137 lines added across 6 files (README, opencode.json,
     file-utils.ts, provider-schema.ts NEW, task-queue.test.ts NEW,
     boot-check.ts)
- ✅ Auditor invocation 1/8 fired cleanly
- ✅ Run completed naturally

This is the first successful blackboard run since the investigation
started.

## Why discussion presets weren't affected

Council, debate-judge, role-diff, mapreduce, stigmergy, round-robin all
use `"swarm-read"` (and got the same marker hallucinations) but their
outputs are FREE-FORM PROSE — the parser doesn't care about JSON
structure. Markers were just visual noise, not parse-blocking. So those
6 discussion presets passed all night with the same model that broke
blackboard + ow-deep.
