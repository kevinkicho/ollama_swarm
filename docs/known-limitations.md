# Known Limitations

Deliberate trade-offs in the current build. Each entry names the choice, why
we made it, and what would force us to revisit. Anything that becomes a
*real* problem in practice should graduate out of here into a plan item.

---

## Planner does double duty as the replanner

**Choice:** when a todo goes stale (Phase 6), the **planner agent** handles
the replan. We do not spawn a dedicated replanner agent.

**Why:** the planner already has the repo context loaded and a system prompt
that understands the todo shape. Reusing it keeps agent count stable and
token usage low. Only the *prompt* differs — the replan prompt includes the
stale reason and the current state of affected files — the *agent* and its
session are the same.

**When this would need revisiting:**
- If we want the replanner to run on a different model (e.g., a cheaper one
  for retries) or with different parameters (lower temperature, shorter
  context).
- If the planner's system prompt needs to specialize so hard in one direction
  that it starts producing worse replans.
- If we hit token-budget pressure where sharing one agent's context across
  planning and replanning causes context bloat — at that point a dedicated
  replanner with a fresh session is cheaper than one planner with a
  ballooning transcript.

Until any of those bite, one agent covers both roles.

---

## Hard caps are compile-time constants, not per-run config

**Choice:** Phase 7's wall-clock / commits / todos caps live as
`export const` in `server/src/swarm/blackboard/caps.ts`. They are not
exposed via `RunConfig`, env vars, or a settings UI.

**Why:** caps are a *safety valve* — they exist so a pathological run can't
burn forever, not so users can tune throughput. Today's defaults (20 min
wall-clock, 20 commits, 30 todos) are well above anything a normal run
touches, so making them per-run configurable adds a schema-validation surface
without solving a problem we have.

**When this would need revisiting:**
- If we want to run the swarm on very large repos where 30 todos is a real
  ceiling rather than a paranoid one.
- If we add a billing/budget layer and users need to hard-cap tokens per run.
- If different presets (blackboard vs. future presets) need different caps
  and `caps.ts` no longer wants to be global.

Until then, the numbers in `caps.ts` are the one source of truth.

---

## ~~Planner/auditor can put directory paths in `expectedFiles`~~ (resolved 2026-04-21)

**Status:** fixed. Trailing `/` or `\` on any `expectedFiles` entry is now
rejected at zod parse time in all four LLM-facing parsers (planner, auditor
todos, auditor newCriteria, replanner, first-pass contract) with the message
"must be a file path, not a directory". The offending item is dropped with a
clear reason rather than reaching the Board and tripping `EISDIR` at hash
time. System prompts in each of those modules now spell out "FILE paths,
never directories" with examples (`src/`, `__tests__/`, `docs/`). The
first-pass contract prompt additionally steers toward `expectedFiles: []`
over a guessed directory, which also addresses the adjacent path-grounding
limitation below.

**Original symptoms (preserved for context):** When a worker hashed the
paths at claim time, a directory entry tripped `EISDIR: illegal operation
on a directory, read` and the todo went stale. The replanner then revised
or skipped it — noisy but safe. Phase 11c smoke run on
`kevinkicho/kBioIntelBrowser04052026` showed 7+ stale events purely from
directory-path todos (`src/`, `__tests__/`, `src`). The fix closes that
loop at the parse boundary so directory entries never cost a replan
attempt.

---

## First-pass contract's `expectedFiles` aren't grounded in repo structure

**Choice:** the first-pass contract emits `criteria[].expectedFiles` from
the mission wording. The agent sees a ~200-entry tree dump and the
top-level README during seed, but it doesn't stat the guessed paths or
verify they correspond to where work will actually land.

**Why:** the first-pass agent's job is to turn a vague mission into a
concrete exit contract quickly. Grounding every `expectedFiles` entry in
repo reality would need a deeper read pass. We kept it cheap and trusted
the downstream planner + auditor to reconcile anchors.

On the 2026-04-21 medium run (`kevinkicho/multi-agent-orchestrator`,
commit `18588b9`), the contract said `src/brain/team-manager.test.ts` but
the actual module lives at `src/team-manager.ts`. Workers correctly
routed tests to `src/tests/team-manager.test.ts`, the auditor observed
the mismatch on invocation 1, and re-dispatched new todos with corrected
anchors — but the wall-clock cap tripped before audit #2 could assess
the repath. Three criteria (c1/c2/c3) stayed `unmet` purely because the
original contract path didn't match the file the work landed in.

**When this would need revisiting:**
- If repath-driven wasted rounds push runs into `cap:wall-clock` where
  they would otherwise complete — phase 11c validation showed ~8 min of
  21.8 min spent on path reconciliation.
- If the auditor starts conflating "path mismatch" with "work missing"
  and the distinction stops being reliable.

Until then, the cheap fix is a system-prompt sharpening: tell the
first-pass contract agent to prefer empty `expectedFiles` over guessed
anchors when the mission doesn't name a file, and let the planner bind
real paths after its own read pass. The auditor could also be given
permission to rewrite a criterion's `expectedFiles` when the committed
work clearly satisfies the *intent* at a different path. Small follow-up,
not a plan item.

---

## ~~Wall-clock cap uses `Date.now()`, not a monotonic timer~~ (resolved 2026-04-23, Unit 27)

**Status:** fixed. The wall-clock cap no longer measures
`Date.now() - runStartedAt`. Instead, `checkAndApplyCaps` advances a
`TickAccumulator` (see `caps.ts`) per call, with each inter-tick
delta clamped into `[0, MAX_REASONABLE_TICK_DELTA_MS]` (5 min). A
multi-hour host sleep now contributes at most 5 min to the cap math
instead of the full suspended duration, and the cap decision is
driven by the accumulator's `activeElapsedMs` rather than wall-clock
subtraction. When a jump > 1 min is detected (i.e., the clamp
discarded real-time), a transcript line is appended noting how much
was skipped — useful for post-mortems of unattended overnight runs.

`runStartedAt` itself is still stamped via `Date.now()` and used for
summary.json / logging (where a wall-clock origin is what a human
expects); only the *cap decision* is host-sleep-compensated.

**Original symptoms (preserved for context):** If the host slept
during a run (laptop lid closed, OS suspend), `Date.now()` jumped
forward on resume while the node event loop was paused. On the next
turn-tick, the cap check read a wall-clock delta of many hours and
the runner immediately stopped with `stopReason: "cap:wall-clock"`
and the static `"wall-clock cap reached (20 min)"` detail string —
even though actual work took far less than the cap. V7 of
phase11c-medium showed `wallClockMs: 31_273_500` (~8h 41m) with
`stopReason: "cap:wall-clock"` — see
`runs/phase11c-medium-v7/comparison-v6-v7.md` for the full
post-mortem. Unit 23's bump of the cap to 8 h did not fix this; it
just raised the threshold at which a long sleep would cross the
line. Unit 27 addresses the root cause so cap math measures active
work rather than clock passage.

---

## ~~`RoundRobinRunner.runTurn` has no retry wrapper~~ (resolved 2026-04-22, Unit 16)

**Status:** fixed for ALL non-blackboard runners. The retry loop that
lived inline in `BlackboardRunner.promptAgent` was extracted to a
shared `server/src/swarm/promptWithRetry.ts` and every runner
(round-robin, role-diff, council, orchestrator-worker, debate-judge,
map-reduce, stigmergy) now calls it. Same retry semantics blackboard
already had: 3 attempts with 4 s + 16 s backoff on transient
codes (`UND_ERR_HEADERS_TIMEOUT` / `ECONNRESET` / etc.); never
retries `AbortError` or non-retryable HTTP 4xx; surfaces a
`retrying` AgentStatus with retry counter so the UI doesn't show a
silent "thinking" during backoff. Paired with `HEADERS_TIMEOUT_MS`
bumped 90 s → 180 s in `httpDispatcher.ts` to catch more legitimate
cold-start TTFB before it ever needs a retry.

**Original symptoms (preserved for context):** the 2026-04-22
role-diff E2E run completed with 4 of 5 agents marked `failed` —
agents 2–5 hit `UND_ERR_HEADERS_TIMEOUT` on their first turn and
never recovered. The 2026-04-22 battle test on six presets surfaced
the same pattern across role-diff, council, OW, debate-judge,
map-reduce, and stigmergy — 25 timeouts in 60 minutes of runs,
~50% of expected agent turns lost. With Unit 16, all seven runners
have the same retry semantics blackboard's been using since Phase
11c.

---

## ~~`AgentManager.toStates()` reports every agent as `"ready"`~~ (resolved 2026-04-22, Unit 21)

**Status:** fixed. `AgentManager` now maintains a private
`agentStates` map mirroring every state change. A new
`setAgentState(s)` helper writes to both the map AND fires the
broadcast `onState` callback in lockstep. All 6 prior direct
`this.onState(...)` callsites (spawnAgent / exit handler / markStatus
/ killAll loop) route through the helper. `toStates()` reads from
the map (sorted by index) and `killAll` clears it. REST
`/api/swarm/status` and WS-catchup snapshots now reflect actual
agent statuses (retrying / failed / etc.); UI agent panels switch
colors live during retries and failures.

**Original symptoms (preserved for context):** the REST snapshot
hard-coded `status: "ready"` for every agent regardless of actual
state. The role-diff E2E monitor script
(`scripts/monitor-role-diff.mjs`) reported `Irregularities: None`
despite 12+ `UND_ERR_HEADERS_TIMEOUT` events because it polled REST
for agent statuses and got stale `"ready"` for dead agents.
