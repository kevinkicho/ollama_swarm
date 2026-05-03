# MoA tool dispatch — design draft (DEFERRED)

**Status**: PROPOSAL · 2026-05-02 · matrix row #4 · awaiting Kevin's nod before code.

This is the biggest single quality lift for MoA — letting proposers
make actual tool calls (read / grep / list) before drafting. Today they
work from a fixed pre-fetch (lever #129) which helps for static reads
but can't verify dynamic facts.

## What's blocking this today

MoA's prompt path is `promptWithRetry` (in `server/src/swarm/promptWithRetry.ts`).
It does NOT take tool definitions or dispatch tool calls. It's a thin
wrapper around `pickProvider().chat({ messages })` — fire-and-receive,
no agentic loop.

BlackboardRunner uses a different path — `promptAgent` (line 4113) — which
DOES handle tools via the planner/auditor "swarm-read" profile + the
`ToolDispatcher` in `server/src/tools/ToolDispatcher.ts`. But that
method is ~250 LOC of operational scaffolding (abort, watchdog, status
emission, retries) tightly coupled to BlackboardRunner's instance
state. Lifting it into a shared helper for MoA to use is a refactor,
not a small addition.

## Two architectural paths

### Option A: Add tool dispatch to `promptWithRetry`

**Shape**: extend `PromptWithRetryOptions` with `tools?: ToolSpec[]` and
`toolDispatcher?: ToolDispatcher`. When set, the function loops:
```
1. Send prompt + tools to provider
2. Provider returns either text OR tool_use blocks
3. If tool_use: dispatch each tool call, append tool_result to messages,
   loop back
4. If text: return
5. Cap iterations at MAX_TOOL_LOOPS (e.g. 10) to bound runaway loops
```

**Pros**:
- Localized — only one file changes; every caller of promptWithRetry
  gains tool support uniformly (council, mapreduce, ow, ow-deep, etc.
  all benefit, not just MoA)
- Easier reasoning — the tool loop is a known shape (Anthropic SDK,
  OpenAI's function calling, Ollama's `tools` param)

**Cons**:
- Provider abstraction must support tools — Ollama's `tools` parameter
  works for some models but not all (gemma4 ✓, glm-5.1 unclear)
- The retries semantics get more complex (does a failed tool call
  trigger the retry path?)

**Estimated**: ~200 LOC + ~40 LOC tests + per-provider validation work.

### Option B: Extract `BlackboardRunner.promptAgent` into a shared helper

**Shape**: lift the operational scaffolding into a `agentPrompter`
module that any runner can construct. BlackboardRunner becomes a
thin wrapper; MoaRunner gains the same capability.

**Pros**:
- The existing tool loop is battle-tested in blackboard runs
- Status emission + abort + watchdog "just work" when extracted

**Cons**:
- Invasive refactor of BlackboardRunner — the method touches ~12
  instance fields (turnsPerAgent, activeAborts, opts.manager.touchActivity, etc.)
- Risk of subtle behavior change in blackboard during the extraction
- ~400 LOC moved + per-runner integration

**Estimated**: ~500 LOC + ~80 LOC tests + careful blackboard regression
testing.

## Recommendation

**Option A.** Adding tool dispatch to `promptWithRetry` is bounded, the
loop shape is well-understood from existing tool-call implementations,
and it benefits more than just MoA. The Ollama-tools-support question
is real but tractable — start with the models known to support it
(gemma4, llama3.2+) and gate via a per-model capability flag.

## Open questions

1. **Tool surface scope.** Read-only is the obvious starting point
   (read, grep, list, glob). Should we include `bash` for things like
   `wc -l`, `git log --since=`? Bash is a much wider blast radius.
   Recommendation: start read-only; add bash later in its own session
   with sandbox profile (`swarm-read` already exists).
2. **Tool loop cap.** What's MAX_TOOL_LOOPS? Blackboard's planner/auditor
   has no explicit cap — it relies on the prompt structure. A bare cap
   of 10 is safe for proposers who shouldn't be running long agentic
   loops.
3. **Per-proposer vs per-round.** Does each proposer get their own
   tool budget, or is there a shared cap? Probably per-proposer with
   cap=5 — keeps total cost bounded.
4. **Streaming with tools.** The current streaming path (`onChunk`)
   doesn't know about tool_use blocks. Would need to either disable
   streaming when tools are enabled OR teach the stream-handler to
   detect + buffer tool_use chunks separately.

## Concrete next step

Kevin reviews this doc and picks Option A or B. Then phase 1 ships:
**read-only tool dispatch in promptWithRetry, gated behind a per-call
opt-in (`tools: [...]` param); MoA opts in for proposers; other
discussion runners stay opt-out for now.** ~200 LOC, ~3-4 hour focused
session.
