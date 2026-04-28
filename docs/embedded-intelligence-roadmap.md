# Embedded intelligence roadmap

> Captured 2026-04-27 evening during overnight tour. Pivot from
> hardcoded rules to AI-assisted logical decisions throughout the app.

## Vision

Today's app uses fixed code paths for every decision: which preset to
use, which prompt to send, which model gets which tools, what to do
when something fails. Most of these decisions could be smarter if a
small local AI model observed the situation and proposed an action.

Goal: **embed intelligence pervasively, not just at the agent layer**.
The agents do the actual work; the embedded intelligence makes the app
itself adaptive.

## Why this matters

We hit this idea while debugging #231 (XML pseudo-tool-call markers).
The hardcoded-regex fix would need maintenance every time a new model
emits a different format. A smarter app would notice format drift and
adapt without code changes.

But the real upside is broader than format-translation. There are
LOTS of places where adaptive intelligence > hardcoded rules in this
app — places where today we either (a) hardcode a brittle rule, or
(b) require manual user intervention.

## Candidate slices (independent, ranked by leverage)

### Tier 1 — most leveraged, lowest risk

- **Auto RCA on failed runs.** Today: a human reads the run summary +
  transcript, identifies the failure mode, proposes a fix. We did this
  manually 8+ times tonight (preset-N-RCA.md docs). A small AI could
  read summary.json + transcript-final.json and produce the RCA doc
  automatically. Read-only — no blast radius. Lets the user skip the
  10-min manual analysis on every failed run.
  - **Effort**: 1-2 days
  - **Triggered**: any run with stopReason ≠ "completed" or commits=0
  - **Output**: `runs/_monitor/<runId>/AUTO-RCA.md`

- **Live failure-mode detection.** Today: a user has to watch the live
  transcript to notice "the model is spiraling" (e.g., 100+ markers,
  repeated empty responses, planner returning [] consecutively). A
  small AI watching the transcript stream could detect these patterns
  and (a) flag them in the UI, (b) optionally intervene (kill the
  current pass, swap models, simplify the prompt).
  - **Effort**: 1-2 days
  - **Triggered**: continuously during a run; samples every 30s
  - **Output**: chip in the UI + optional auto-intervention

### Tier 2 — high upside, more complex

- **Dynamic tool-grant policy.** Today: opencode.json hardcodes
  `swarm` (no tools) and `swarm-read` (read tools). We pick per-prompt
  which to use. A smarter version: at agent spawn, probe the model
  with a test prompt; if it emits structured tool_calls, use
  swarm-read; if it emits XML in text, use swarm. Cache the result
  by `(providerID, modelID)`. No more guessing about which models can
  use tools properly.
  - **Effort**: 1-2 days
  - **Triggered**: agent spawn (one extra prompt + cache lookup)
  - **Output**: per-model capability cache

- **Smart preset selection.** Today: user picks a preset from a
  dropdown. A smart version: given a user directive, infer which
  preset best matches it (refactor → blackboard, design discussion →
  council, debate → debate-judge, etc.). Could surface a "we
  recommend X" suggestion alongside the manual picker.
  - **Effort**: 1 day (reuses existing preset descriptions as
    classification context)

- **Memory consolidation across runs.** Today: `.swarm-memory.jsonl`
  appends one line per run end. We READ them in subsequent runs but
  don't compress / deduplicate / extract patterns. A periodic
  consolidator (run every N runs OR every M days) could distill the
  raw log into "lessons that consistently apply" vs "one-off
  anecdotes" — making the planner's prior-memory context tighter.
  - **Effort**: 2-3 days
  - **Triggered**: cron OR explicit user action
  - **Output**: rewritten `.swarm-memory.jsonl` with "consolidated"
    section + "raw" section

### Tier 3 — speculative

- **Adaptive system-prompt tuning.** Observe model behavior across
  runs (success rate, parse failures, marker counts), automatically
  propose system-prompt adjustments. Could even A/B them across
  parallel runs. Highest upside, most fragile.
  - **Effort**: 2-3 days for prototype, ongoing tuning forever

- **Format-translator agent.** Local small model translates whatever
  text-format the planner emits into canonical tool-calls. Considered
  + rejected for the immediate XML-marker problem (constrained
  decoding is correct-by-construction and simpler), but would be
  worth revisiting if we end up with multiple model families emitting
  different formats AND structured output isn't supported by the
  underlying provider.

## What this is NOT

- A justification for adding a translator/adapter layer for every
  problem. Constrained-decoding (option #3) for the XML marker bug is
  the correct fix BECAUSE it eliminates the variability at the
  source. Translators on top are the wrong answer when you can fix the
  source.
- A multi-month all-at-once redesign. Each slice above is independent
  and ships as a discrete improvement.
- A replacement for the existing agent pipeline. Embedded intelligence
  = decisions ABOUT the pipeline (which preset, which model, which
  prompt). The pipeline still does the actual work via the existing
  blackboard/council/debate runners.

## Suggested order

1. Ship **constrained decoding** for the XML marker bug (option #3) —
   correct-by-construction; closes #231 properly without an adapter.
2. Build **auto RCA** as the first embedded-intelligence slice. Most
   leveraged, lowest risk, gives you immediate ROI on every failed run.
3. Layer in **live failure detection** next. Builds on auto RCA's
   observation infra — same data inputs, just continuous instead of
   post-mortem.
4. After 2 + 3 are stable, evaluate which Tier 2 slice has the most
   pull (probably "dynamic tool-grant policy" since it would have
   prevented #231 entirely).

## Open question

A small local model for the embedded-intelligence work — what model?
Candidates that fit "fast + reliable structured output + small enough
to run alongside the main models":
- Phi-3-mini (3.8B)
- Llama-3.2-3B
- Qwen2.5-3B
- Gemma-3-2B (if available)

All ~1-3s per call, all support OpenAI-compatible structured output.
Likely worth probing each on the same task and picking the most
reliable. Ollama can host any of them locally so no cloud-quota burn.

## Trigger to revisit

Pick this up when:
- The XML marker bug (#231) is fully closed via constrained decoding
- Or when a NEW format-drift problem surfaces that constrained
  decoding can't solve
- Or when a user explicitly asks "let's start auto-RCA"
