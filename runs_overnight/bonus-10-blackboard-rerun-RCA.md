# Bonus 10 — blackboard re-run with #229+#230 fixes — FAIL (validates the fix scope)

- **runId**: `acb3f05f`
- **preset**: blackboard, fresh clone in runs_overnight2/, 4 agents + auditor, rounds=8
- **outcome**: `no-progress` after 2m
- **commits**: 0 (same as preset 1)

## What changed vs preset 1 (post-fix vs pre-fix)

**Pre-fix (preset 1)**:
- Planner contract response leaked dozens of XML markers as VISIBLE bubble text
- Repair fired, eventually contract parsed
- Todos pass emitted `</think>\`\`\`json[]\`\`\`` (closing tag leak + empty array)

**Post-fix (this run)**:
- Bubble shows "(empty response)" instead of marker text — the strip works ✓
- BUT the underlying planner output is still empty after stripping
- Repair attempt with sibling model emitted `<list path='...'>` only — also stripped to empty
- "Giving up this run"

## Validates fix scope

This is the EXPECTED result based on the RCA after #229 was shipped. The strip fix:
- ✅ Closes the UI noise piece (no marker text in bubble)
- ✅ Closes the Phase 2 over-segmentation piece (no marker-driven \n\n boundaries)
- ✅ Surfaces the underlying issue clearly ("(empty response)" is more honest than marker noise)
- ❌ Does NOT change the planner success rate — model behavior is unchanged

The actual fix for the planner success rate would require:
1. Tighter system-prompt rules forbidding markers (already attempted, not enough)
2. A pre-execute layer that interprets markers as actual tool calls and feeds back results to the model
3. A different model that doesn't hallucinate markers
4. SDK tool-grant configuration changes (the models see tool definitions and try to emit them as text)

## Insight: even sibling-model fallback emits markers

The repair prompt routed to `nemotron-3-super:cloud` (sibling of `glm-5.1:cloud`) per #34db7f9. The repair response was ALSO marker-only (`<list path='...'>`), proving the issue is NOT glm-5.1-specific. Multiple models from different families exhibit the same hallucinated-tool-call behavior on this repo + this prompt context.

This is a systemic issue worth a separate investigation — likely the SDK tool-grant context in the agent's system prompt is leading the model to emit the granted tools as text.

**Queued**: #231 — investigate planner system prompt + opencode SDK tool-grant; one model emitting markers is bad luck, two from different families is a pattern.
