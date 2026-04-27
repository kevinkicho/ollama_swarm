# ADR 005 — Keep opencode (for now); don't bypass for non-blackboard runners yet

**Status:** accepted
**Decided:** 2026-04-27 (after the "do we still need opencode?" thread)
**Last verified:** 2026-04-27

## Decision

`OllamaClient` (the V2 direct-to-Ollama path) only replaces opencode
inside `BlackboardRunner`. The other 7 runners (round-robin, role-diff,
council, orchestrator-worker, orchestrator-worker-deep, debate-judge,
map-reduce, stigmergy) still go through opencode subprocesses.
Opencode is *not* getting deleted in this iteration.

## Context

`OllamaClient` is the V2 path that talks chunked HTTP straight to
Ollama (skipping opencode's openai-compatible proxy). It works.
Behind `USE_OLLAMA_DIRECT=1`, blackboard's planner/worker/auditor
prompts go straight to Ollama and the `opencode serve` subprocess
is unused for the actual model traffic (though the subprocess is
still spawned for session ID + warmup ping).

The natural next question: "if direct Ollama works for blackboard,
why not rip out opencode entirely and have all 7 other runners use
the same direct path?" We considered it. Not yet.

## Alternatives considered

1. **Rip opencode now.** Wire `OllamaClient` through all 7
   non-blackboard runners. Delete `AgentManager.spawnAgent`,
   `RepoService.writeOpencodeConfig`, the `opencode.json` synthesis,
   the per-agent port allocation. Result: single-binary install
   where users only need Ollama running. ~1 week of refactor.
   Risk: 7 runners haven't been validated against the direct path;
   each has its own prompt-shape assumptions about what `streamPrompt`
   returns (envelope vs. plain text vs. structured JSON).

2. **Keep opencode for non-blackboard, drop for blackboard
   eventually (this ADR).** `OllamaClient` proves itself in
   blackboard (the hardest preset — multi-agent + write path +
   structured JSON envelopes). Once blackboard is V2-only and
   stable, the patterns + prompt-handling code transfer to the
   other 7 runners as a separate ratchet.

3. **Keep opencode permanently.** Accept the per-agent-subprocess
   overhead (~50MB × N agents) and the install requirement. Loses
   the "single-binary" UX win.

## Trade-offs

- **Cost:** users still need to install opencode. The "Quick start"
  in README.md lists it as a prerequisite. This is friction for new
  users.
- **Cost:** maintaining two paths in parallel — the opencode SDK
  path + `OllamaClient` direct path — means changes to model
  handling (e.g. token tracking, retry logic, timeout behavior)
  often need to be made in both places.
- **Win:** validation surface stays manageable. Switching all 7
  runners at once would be a multi-preset regression test in one
  commit. Doing it after blackboard is V2-only means the V2 path
  has weeks of multi-prompt validation in production already.
- **Win:** the `OllamaClient` API gets shaped by the hardest preset
  first. Whatever shape works for blackboard's structured envelopes
  will trivially handle the discussion presets' plain text.

## When to revisit

- When blackboard is `USE_OLLAMA_DIRECT=1 USE_WORKER_PIPELINE_V2=1`
  default-on for 2+ stable production runs (currently opt-in).
  At that point, the "drop opencode" work is queued in
  `active-work.md` ("Risky cutovers") and waits on an explicit user
  go-ahead.
- If a critical opencode bug surfaces that we can't work around but
  V2's direct path is unaffected — that would force the cutover
  early.
- If opencode itself adds a feature we want and it's faster to
  consume than to reimplement in `OllamaClient` (currently neither
  side is moving fast on features that affect us).

## References

- `server/src/services/OllamaClient.ts` — the V2 direct path
- `server/src/services/AgentManager.ts` — opencode subprocess
  spawning + SDK client per agent
- `server/src/services/RepoService.ts:writeOpencodeConfig` —
  opencode.json synthesis (would be deleted in the cutover)
- `docs/active-work.md` — "Drop opencode subprocess dependency
  entirely" item, with the ~1-week refactor breakdown
- ADR 001 — explains why we have one opencode subprocess per agent
  (relevant context for what's actually being kept)
