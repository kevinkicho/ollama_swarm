# Preset 1 — blackboard — RCA

- **runId**: `af27f55c-75d7-47e6-9ad4-75656a1763ea`
- **target**: `multi-agent-orchestrator` (fresh clone)
- **preset**: blackboard, glm-5.1 planner, gemma4 worker, nemotron auditor
- **directive**: "Refactor supervisor.ts: extract shared retry-with-backoff loop into reusable helper"
- **outcome**: `no-progress` after 7m 4s (well under 1h cap)
- **commits**: 0
- **valid todos**: 0

## Failure mode

Cascade:

1. **Planner contract response leaked XML tool-call markers** (active-work known issue).
   Entry 10: 6011 chars of `<read path='src/supervisor.ts' start_line='1' end_line='100'>`
   plus 30+ similar lines (with no actual JSON). Required repair prompt.

2. **After repair, contract parsed cleanly** with 6 criteria scoped to
   supervisor.ts + retry-related test files.

3. **Todos pass produced `[]`** (entry 14, 22 chars):
   ```
   </think>```json
   []
   ```
   ```
   The `</think>` closing-tag leak happens when the response starts
   mid-thought (no matching opening `<think>`). Phase 1 extractThinkTags
   only strips paired tags — unpaired closers leak.

4. **Sibling-model fallback to `nemotron-3-super:cloud`** also failed
   (entry 16, 16 chars): `["See analysis"]` — fake placeholder string,
   not actionable JSON.

5. **Schema validation dropped 1 todo** (presumably the `["See analysis"]`
   shape). 0 valid todos remained → `no-progress` exit.

## Findings (queued)

- **#229 (NEW): unpaired `</think>` closer leaks** when planner response
  starts mid-thought. Phase 1 extractThinkTags handles paired tags only.
  Fix: also strip an unpaired `</think>` from the head of the text and
  treat the prefix as thoughts.

- **Active-work item "TOOL-CALL XML MARKERS"** is now confirmed
  WORK-BLOCKING, not just UI noise. Every blackboard run with glm-5.1
  planner needs a repair prompt for the contract pass; if a similar
  regression hits the todos pass, the run dies. Server-side stripping
  before the parse is the right fix.

- **Sibling-model fallback insufficient on its own.** When both models
  emit garbage, the run exits no-progress. This is by design (don't
  loop forever) but it means model selection matters more than fallback.
  Worth considering: a third-attempt with a stripped/coerced response
  ("just give me the JSON, no thinking"), or letting the user resume
  with a different model via the start gate.

## Did not test

- Phase 4 of UI coherent-fix (think-tag rendering live) was already
  partially exercised but the SHAPE here (unpaired closer) wasn't a
  case the fixture covers. Add it to the gallery.
