# Postmortem: stream guards and loop detection removed (2026-07-09)

## Summary

Stream character caps, intra-stream loop detection, stream-abort retry prompts, and
default turn-level loop halting were **removed from all live prompt paths**. They
increased wall-clock time and token spend more than they prevented runaway output.

**Do not re-enable** without explicit product-owner approval and a new design that
does not multiply work on abort. See `docs/decisions.md` (2026-07-09 entry).

## Symptoms users saw

- Council/blackboard **contract explore** agents streaming 100K–160K chars of
  reasoning (“Let me check bonds… Let me check credit…”) before any deliverable.
- Runs feeling **2×–4× slower** than necessary.
- **Bloated AI cost**: aborted attempts were billed, then retried from scratch.

## What we had deployed

| Mechanism | Behavior |
|-----------|----------|
| **Stream char guard** | Abort at 100K chars before first tool call (1M after tools) |
| **Intra-stream loop detector** | Abort on identical chunks, suffix repeat, zero-byte streak, pseudo-tool XML storms |
| **`promptWithRetry` on guard abort** | Up to 3 attempts with 30s + 90s backoff |
| **Stream-abort retry addendum** | Prepend “DO NOT repeat this excerpt” + 2.5K char tail to next prompt |
| **`chatOnceWithStreaming` retries** | 2 attempts on pre-passes |
| **`SWARM_LOOP_DETECTION` / turn-level Jaccard** | Could warn and halt whole run after 3 detections |

## Why guards multiplied work (root cause)

1. **Late abort, full discard** — Guard fired after 80–100K tokens of reasoning;
   that spend was thrown away.
2. **Retry from scratch** — Next attempt got original explore prompt + abort block;
   model re-read the same files and re-stated the same analysis.
3. **Nested retry stacks** — `promptWithRetry` (3×) inside `runPlannerEmitRecovery`
   (8×) → up to **24 LLM calls** per contract phase.
4. **Wrong target** — Long varied reasoning (“let me check X… let me check Y…”) often
   **did not** match byte-identical loop checks; stream guard punished length, not
   true repetition.
5. **False positives** — Cloud providers emit fixed-size frames; intra-stream detector
   could abort healthy streams and trigger another full pass.

Guards converted **one unbounded waste** into **several bounded wastes** — still
unacceptable for cost and latency.

## What we do instead

- **No stream caps or intra-stream aborts** in `promptWithRetry`, `chatOnceWithStreaming`,
  or council/blackboard adapters.
- **Transport retries only** for network/timeouts (unchanged `RETRY_MAX_ATTEMPTS=3`).
- **User stop / drain** — manual escape hatch for true runaway (unchanged).
- **Prompt design** — prefer “emit after N tool calls” in explore prompts if models
  ramble (future, not guards).
- **`semanticLoopDetector.ts`** and **`intraStreamLoopDetector.ts`** — deleted.

## Cost impact (illustrative)

One council explore abort at 100K output chars, then 2 retries:

- Attempt 1: ~100K output tokens (wasted)
- Attempt 2: ~100K+ again (partial overlap with attempt 1)
- Attempt 3: another pass

Plus 30s + 90s backoff wall-clock. Same logical work billed **2–3×** without
guarantee of a better outcome.

## Related runs

- Blackboard/council panel runs (e.g. kyahoofinance clone) with long reasoning
  bubbles during contract explore.
- User report: guards felt like agents doing “double, triple, quadruple” work.

## Status

**Removed.** Server restart required after deploy.