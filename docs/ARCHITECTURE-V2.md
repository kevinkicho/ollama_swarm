# ollama_swarm — Architecture V2

> Written 2026-04-26 after a session of cascading fixes that exposed
> systemic overfitting. This is a re-think from first principles by an
> engineer who would rather rewrite than keep patching.

## Status (last updated 2026-04-27)

| Shift | Status | Notes |
|---|---|---|
| 1. Drop OpenCode subprocesses → talk to Ollama directly | **partial** | `OllamaClient` substrate shipped (`server/src/services/OllamaClient.ts`); `BlackboardRunner` uses it when `USE_OLLAMA_DIRECT=1`. Non-blackboard runners still go through opencode SDK. Subprocess management not yet removed — see "Drop opencode dependency" path in repo state. |
| 2. Single state machine for runs | **substrate done** | Pure reducer in `shared/src/runStateMachine.ts` with 33 tests. `RunStateObserver` wires it into `BlackboardRunner` as parallel-track instrumentation; full event wiring + `checkPhase` at every `setPhase` ships in commit `39965ea`. `v2State` lands in run summary + UI surface. |
| 3. One bubble. One parser. | **done** | `shared/` workspace ships: `extractJson`, `TranscriptEntrySummary`, `summarizeAgentJson`, `formatServerSummary`. `Bubble` extracted into `MessageBubble.tsx` (Transcript.tsx 612→91 LOC). DRY'd 5 synthesis branches into one helper. |
| 4. Streaming = chunked HTTP, no SSE | **partial** | `OllamaClient` does direct chunked-HTTP read with idle-timeout. Used when `USE_OLLAMA_DIRECT=1`. SSE path still in place for non-V2 routes; not yet deleted. Several SSE-stability fixes landed alongside (stale-session.idle filter `18a7749`, SSE-aware turn watchdog `189ca05`). |
| 5. TODO queue, not "Board" | **substrate done** | `TodoQueueV2` (FIFO) + `WorkerPipelineV2` (apply + git commit, adapter pattern) + `v2Adapters` (real fs+git) all shipped with tests. `BlackboardRunner` runs `TodoQueueV2` as parallel-track mirror via `onBoardEvent` (commit `41fa509`). When `USE_WORKER_PIPELINE_V2=1`, `executeWorkerTodoV2` routes worker writes through `applyAndCommitV2` (commit `7040a96`, validated 4 commits + 0 divergences). Board.ts not yet deleted. |
| 6. Event-log UI | **substrate done** | `EventLogReaderV2` parses `logs/current.jsonl` + derives state. `/api/v2/event-log/runs` endpoint + `EventLogPanel` header dropdown ship the read path. UI doesn't yet derive *live* state from events — still WS-snapshot-mirror primary. |

**Summary**: every section has substrate shipped + tested + parallel-track instrumentation; Sections 1, 4, 5, 6 still have an integration step before V1 code can be removed. The substrate work makes those integration steps reversible — flip the env flag off and V1 paths take over. Tests: 972/972 passing.

**Validation passed (2026-04-27)**: 7/7 SDK-path presets (round-robin, council, role-diff, OW, OW-deep, debate-judge, map-reduce, stigmergy) ran clean — 0 empty responses, 0 stale-idle skips, 0 SSE-aborts, 0 V2 reducer divergences. Earlier blackboard validation produced 4 V2 commits with proper author attribution + 0 queue/state divergences.

**Recently shipped fixes that are foundational (not in original 6 shifts but enabled them):**
- `bb0c509` — `OLLAMA_BASE_URL` always terminated with `/v1` so opencode's openai-compatible adapter doesn't 404. Pre-fix, an env var without `/v1` silently broke every opencode prompt.
- `18a7749` — `streamPrompt` filters stale `session.idle` from prior `session.prompt`'s tail (warmup or earlier streamPrompt). Pre-fix, the next prompt's stream resolved with empty text.
- `189ca05` — Wall-clock 4-min "absolute turn cap" replaced with SSE-aware liveness watchdog (`sseAwareTurnWatchdog.ts`). Aborts on 90s SSE silence OR 30-min hard ceiling. Pre-fix the wall-clock cap killed prompts the model was still actively producing.



## Why this exists

The current system works. It also accumulates a special-case fix every
time a model misbehaves, a subprocess flakes, or an SSE chunk drops.
Today's session shipped #220 → hotfix → mid-call fix → ping endpoint
fix → false-positive respawn fix → diag tuning. Each layer was correct.
Stacked, they make the system brittle and slow to extend.

Real symptoms:
- `BlackboardRunner.ts` is 3,700+ LOC. Most methods take 8–20 implicit
  dependencies on private fields. The "split it up" task (#164) hit a
  natural floor for surgical extraction; further splits need a shared
  `RunState` object.
- The streaming subsystem has 12+ concerns interleaved: per-chunk
  timeout, REST probe, reconnect loop, SSE-died flag, format sniff,
  message-role filter, per-part accumulator, mid-stream message-id
  changes, prompt-counter for diag, etc.
- Worker exit condition requires 5 separate flags to all be zero
  (`open=0, claimed=0, stale=0, replanPending.size=0, !replanRunning`).
  Any one stuck = whole run wedges. We hit this twice today (different
  causes both times).
- Three different JSON extractors (server `extractJsonFromText`, client
  `extractJson.ts`, client `tryParseWorkerHunks`) doing similar work
  with slightly different rules.
- Bubble routing in `Transcript.tsx` has 6+ paths with summary.kind
  checks, fallthrough to client parsers, fallthrough to AgentJsonBubble,
  fallthrough to JsonPrettyBubble, fallthrough to CollapsibleBlock.

The pattern: every failure mode produces a new code path. The new path
is correct. The system as a whole gets harder to reason about.

## What V2 keeps

The core ideas are good. Don't throw them away:

- **Blackboard pattern**: planner + workers + auditor coordinated via
  shared TODOs. This is the heart of the project.
- **OpenCode-style "envelope" responses**: structured JSON contracts,
  worker hunks, auditor verdicts. Models output JSON; the runner parses
  and acts. Don't change this.
- **Tier ratchet** (Unit 34 / #126): planner climbs ambition tiers
  when criteria are met. Powerful, keep.
- **Per-run memory** (#130, #177): cross-run lessons + design memory.
  Keep.
- **Continuous mode** with budget caps (#132, #137, #156, #165).
  Quota walls + pauses are real production needs. Keep.
- **Ambition modes** for long-horizon work. Keep.

## What V2 changes

Six architectural shifts. Each one removes a class of brittleness.

### 1. Drop OpenCode subprocesses. Talk to Ollama directly.

OpenCode is designed for an interactive code-assistant. We use it as
a thin transport: spawn process → create session → send prompt → read
SSE. The cost is high:

- 5 subprocesses × ~50MB each = 250MB baseline RAM per run
- Cold-start tail per subprocess (warmup pings, session creation)
- SSE-via-SDK indirection (the `createSseClient` auth-header bug ate
  a day; the per-chunk timeout still doesn't reliably fire on 2nd+
  prompts per #223)
- Subprocess management complexity: PID tracking, port allocation,
  orphan reclamation, kill-and-respawn, health checks

What we actually need: send prompt to model, stream response, get text.
Ollama's `POST /api/chat` with `stream: true` does exactly this in 30
lines. No subprocess. No port. No SDK. No SSE.

**Result**: removes ~600 LOC across `AgentManager.ts`, eliminates
~12 task IDs worth of failure modes (#170, #194, #200, #220, #223 etc.
become not-a-problem-at-all because there's no subprocess to die or
SSE to drop), saves 250MB RAM and several seconds of cold start per
run.

**Trade-off**: lose OpenCode's tool ecosystem (`swarm-read` agent
profile with read/grep/glob/list). But our planner uses these only to
inspect the repo — replace with direct fs calls in TypeScript. We
already have the clone path.

### 2. Single state machine for runs.

Replace the implicit coordination across {phase, board.counts,
replanPending, replanRunning, draining, paused, stopping} with one
explicit XState (or hand-rolled equivalent) state machine:

```
idle
  ↓ start
spawning → planning → executing → auditing
                          ↑           ↓
                          └── tier-up ┘
                                      ↓
                          completed | failed | stopped
```

Transitions are explicit functions. No worker can wedge because there
ARE no hidden coordination invariants — the state IS the truth.

**Result**: eliminates the entire `_worker_wait_wedge` problem
(#215/#219/#222). The wedge can't happen because the state machine has
no "all flags must be zero" condition.

### 3. One bubble. One parser.

Web-side: replace `Bubble` (6+ branches) with one `<AgentResponse>`
component:

```ts
<AgentResponse
  envelope={parsed}    // discriminated union from shared parser
  rawText={entry.text}
  segments={entry.segments?}
  agentIndex={entry.agentIndex}
  ts={entry.ts}
/>
```

It renders:
- Header (agent N · timestamp · envelope kind chip)
- One-line summary derived from envelope
- Toggleable: Reasoning preamble, Streaming chunks, Raw JSON, Pretty
  JSON, Diff view (for hunks)

Server- and client-side use the SAME parser via a `shared/` directory
with a TypeScript build that emits both ESM (web) and CJS (server)
bundles. One source of truth for envelope shapes and parse rules.

**Result**: deletes ~300 LOC of duplicated parsing, ~250 LOC of
bubble-routing branches. Eliminates the class of bug where server and
client disagree on envelope shape.

### 4. Streaming = chunked HTTP, no SSE.

Ollama streams responses as JSONL lines on the HTTP connection.
We read the stream directly:

```ts
async function streamChat(opts) {
  const res = await fetch(ollamaUrl, { ... });
  const reader = res.body.getReader();
  let text = "";
  for await (const line of readLines(reader)) {
    const msg = JSON.parse(line);
    if (msg.done) return text;
    text += msg.message.content;
    onChunk?.(text);
  }
}
```

Liveness signal: 60s idle on the HTTP body's read = abort the fetch.
That's it. No probe, no reconcile, no reconnect. If the model is dead,
the connection is dead, the read times out, we abort. Retry policy is
external (a few retries with backoff for transport errors).

**Result**: eliminates the per-chunk timeout / probe / reconnect /
SSE-died-flag / mid-call respawn complexity (~400 LOC). #192, #194,
#200, #223 all cease to exist.

### 5. TODO queue, not "Board".

The current Board does claim/CAS/lock-files/expiry/replan. It's
overdesigned for the actual workload (10–20 TODOs per tier, 3 workers).

Simpler model:
- TODOs are a queue (FIFO, in-memory)
- Workers dequeue one at a time
- Worker writes its hunks to disk in a temp branch, runs `git apply`,
  commits to the work branch
- Conflicts: git merge conflict → worker re-fetches the conflicting
  file, retries once, gives up if still conflicting

No claims, no expiry, no per-file locks. Git provides the conflict
detection that "claim with file lock" was reinventing.

**Result**: deletes Board.ts entirely (~330 LOC) and the per-file lock
cache (#205) along with it. `executeWorkerTodo` shrinks dramatically.

### 6. Event-log UI, not snapshot UI.

Runner outputs a JSONL event stream. UI is an event-log viewer that
derives all state from the stream:

```
{ts: 12345, type: "run_started", runId, preset, models, ...}
{ts: 12350, type: "phase", phase: "planning"}
{ts: 12380, type: "agent_chunk", agentId: "planner", text: "..."}
{ts: 12500, type: "todo_posted", id, description, files}
{ts: 12600, type: "todo_committed", id, hunks, lines}
...
```

UI subscribes via WebSocket. State is derived from the event log.
No snapshots, no board_state events, no status mirroring. Page
refresh: replay the log from disk.

**Result**: eliminates the catch-up-on-refresh complexity, the
parallel snapshot+event paths, the per-agent state mirror. Delete
~200 LOC of `setAgentState`/`recordAgentState`/`agentStates` mirror
machinery.

## Migration path

Don't rewrite all at once. The order:

1. **(1 week) Build the Ollama-direct shim**: replace `streamPrompt`
   with `streamChat`. Keep OpenCode subprocesses for non-blackboard
   presets initially. Validate on blackboard runs.

2. **(2-3 days) Move parser to `shared/`**: extract envelope schemas
   and parse functions into a TS package consumed by both server and
   web. Delete duplicates. No behavior change.

3. **(1 week) State machine extraction**: implement the run state
   machine alongside existing code. Switch over preset by preset.

4. **(2-3 days) Single AgentResponse bubble**: rebuild the bubble
   using the shared envelope types. Delete old branches.

5. **(1 week) TODO queue replacing Board**: this is the riskiest.
   Do it on a feature branch, validate against the e2e blackboard
   suite first.

6. **(2 days) Event-log UI**: cut over after state machine + parser
   are settled.

Total: ~4-5 weeks if done sequentially, less if parallelized. Each
step is independently mergeable and reverts cleanly if something
breaks.

## What we explicitly are NOT doing

- **Not rewriting the planner/worker/auditor prompts.** They work.
  Refactor at the prompt level only when prompts themselves are
  causing problems.
- **Not rewriting the UI extractions** (Wave 4: SwarmView, Transcript,
  SetupForm). Those just landed and the splits are fine.
- **Not changing the preset semantics.** Eight presets, blackboard is
  write-capable, others are discussion-only. This is a known good
  shape.
- **Not adding more presets.** The current eight cover the design
  space.

## Decision points the user needs to weigh in on

1. **OpenCode dependency**: V2 drops it. Are there reasons to keep it?
   (Tool support? Familiarity? Future-proofing for Anthropic-via-
   OpenCode?) — if yes, the streaming + subprocess complexity stays.

2. **Multi-agent worker pool**: V2 still supports N workers but the
   default could be 1. Most runs would be faster end-to-end with one
   smart worker than three competing for files. Worth the test?

3. **Migration appetite**: ~1 month of focused work. Worth it now,
   or pay down debt incrementally as we extend?

4. **Backward compatibility**: V2 changes the WS event shape. Existing
   summary.json files would still load but not all fields render the
   same way. Acceptable, or do we need a compat layer?

## Tasks this proposal would close

If V2 ships, these become irrelevant (deleted, not deferred):

- #170 SSE auth header — no SDK
- #174 per-part accumulator — no SSE
- #175/#179 assistant-only filter — no SSE
- #182 mid-stream message wipe — no SSE
- #191/#192/#194/#200 SSE backstop trio — no SSE
- #196 format sniff — replaced by parse-then-fail-fast
- #201 streaming-state tombstones — no concurrent stream calls per agent
- #205 board lock cache — no Board
- #206 PID tracker race — no subprocess
- #215/#219/#222 wedge diag — no wedge-prone state
- #220/#223 respawn / mid-call retry — no subprocess
- ~10 more

V1 has shipped fixes for ~30 specific failure modes. V2 makes most of
those failure modes architecturally impossible.

## What stays the same

- `swarm-design/` design memory store (#177)
- `.swarm-memory.jsonl` cross-run memory (#130)
- Tier ratchet (#126)
- Continuous mode with budget caps (#132, #137, #156)
- Quota wall pause/resume (#165)
- Run summary + history (#85)
- Token tracker (#125, #133, #163)
- Stretch goal reflection (#129)
- Verifier agent (#128)
- Goal generation pre-pass (#127)

These are the features that make ollama_swarm what it is. V2 just
makes the substrate underneath them less brittle.
