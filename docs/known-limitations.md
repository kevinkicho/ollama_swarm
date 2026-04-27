# Known Limitations

Deliberate trade-offs in the current build. Each entry names the choice, why
we made it, and what would force us to revisit. Anything that becomes a
*real* problem in practice should graduate out of here into a plan item.

> **2026-04-27 update:** the V2 substrate (state machine, TodoQueueV2,
> WorkerPipelineV2, OllamaClient, EventLogReaderV2) has shipped + tested
> + parallel-track instrumentation; see `docs/ARCHITECTURE-V2.md` Status
> table for what's done vs pending. Several limitations below are
> on-track for V2 to architecturally remove (rather than fix one bug at
> a time). Look for the **"V2 makes this irrelevant"** marker.

---

## Planner has ALL tools disabled (`swarm` profile, not `swarm-read`)

**Choice:** blackboard's planner and auditor share the `swarm` agent profile
with the workers. That profile has `read: false, grep: false, glob: false,
list: false` and `permission: { edit: deny, bash: deny }`. So the planner
produces its contract with ZERO file inspection — it works only from the
PlannerSeed (repoUrl + topLevel entries + `listRepoFiles` output of 150 paths
+ README excerpt first 4000 chars). The auditor likewise only sees the
specific files named by each criterion's `expectedFiles`, never the
surrounding code.

**Why it happened:** Unit 20 introduced the `swarm-read` profile (read tools
ON, write tools OFF) for discussion presets (round-robin / council /
orchestrator-worker / map-reduce / stigmergy / role-diff / debate-judge).
Blackboard's planner was left on `swarm` by default — workers MUST be on
`swarm` (they must return JSON diffs, not call edit tools directly), but the
planner has no such constraint. The distinction was not thought through.

**Evidence from 2026-04-23 kyahoofinance032926 live smoke**: the planner
produced tier-1 criteria like "add `.gitignore`" and generic README polish —
pattern-matching on "this is a GitHub project, what do GitHub projects
usually need?" rather than analyzing the actual code. A typical 30-KB-README
project never gets its `package.json` inspected, its dependency tree
audited, its existing test harness grepped for gaps, etc.

**When this would need revisiting:** as soon as we want ambitious contracts.
Unit 34's ambition ratchet can't climb meaningful tiers if every tier's
planner is blind to the code.

**Fix direction (Unit 37 candidate, see `docs/autonomous-productivity.md`):**
route the planner + auditor prompts with `agent: "swarm-read"` instead of
`agent: "swarm"`, and update their prompts to explicitly instruct tool use
("inspect package.json, grep for existing patterns, list directories you
suspect are relevant, then propose criteria"). Workers stay on `swarm`.

---

## Agent-lifecycle control is unreliable (orphan accumulation across restarts)

**Choice:** `AgentManager.killAll()` calls `session.abort` then
`treeKill(agent.child)` per agent. `treeKill` on Windows shells out to
`taskkill /F /T /PID <pid>`. This is best-effort with no verification — if
the kill misses (nested child processes, stale PID reference, Windows
permissions hiccup), the subprocess survives.

**Why it's structurally fragile:**

1. Every time our dev server restarts (crash, edit-triggered tsx reload,
   Ctrl-C + manual restart), the new `AgentManager` is a fresh instance with
   an empty `agents` map. It has no knowledge of the previous server's
   spawned opencode subprocesses. Those subprocesses become true orphans —
   nothing ever reclaims them.
2. A stream already in flight to Ollama cloud continues to drain tokens
   until it completes naturally, even after the subprocess is killed. HTTP
   stream cancellation doesn't always propagate to the cloud inference pipe.
3. On user stop, the stop signal has to traverse: browser → our server →
   `Orchestrator.stop()` → runner's `stop()` → `this.stopping = true` + abort
   controllers → `manager.killAll()`. Any link failing silently leaves the
   run running while the UI shows "stopped".

**Evidence from 2026-04-23 live session**: at one point
`GET /api/swarm/status` reported `phase: "executing"` with agents in
`status: "thinking"`, while the UI displayed "failed: user stop" from an
earlier run. Separately, `tasklist` showed 15+ `node.exe` processes on the
box after ~5 runs — most were orphans from prior restarts.

**When this would need revisiting:** multi-day unattended operation — Kevin's
actual goal per `docs/autonomous-productivity.md`. Orphan accumulation in
that regime is unbounded and will eventually exhaust ports / memory / cloud
quota.

**Fix direction (Unit 38 candidate):** PID file per run at
`runs/<slug>/.agent-pids`, written at spawn time and cleared at clean stop.
On dev-server startup, scan `runs/*/.agent-pids` for live PIDs and kill them
before binding the port. Plus verified kill (poll `tasklist /PID <pid>`
after treeKill; escalate if still alive). Native Windows Job Objects would
be the ideal fix but require a native addon or FFI.

---

## Per-agent opencode subprocess amplifies cloud-variance tails

**Choice:** `AgentManager.spawnAgent` spawns one separate `opencode serve
--port <random>` subprocess per agent (3 agents = 3 subprocesses on 3
ports). Each subprocess hosts exactly one session (`session.create` called
once). This is intentional isolation — confirmed preference 2026-04-23:
per-agent opencode subprocess is the right shape.

**Why the tail hurts:** the three subprocesses' first prompts all hit the
cloud at roughly the same time. Each subprocess does independent startup
(HTTP server init, opencode.json read, @ai-sdk/openai-compatible provider
load, first-prompt tokenizer prep). Under concurrent cold-start pressure,
ONE of the N parallel prompts tends to lose the scheduler race and hit the
180-s `HEADERS_TIMEOUT` (undici). The other N-1 return in 25-60 s.

**Evidence from 2026-04-23 kyahoofinance032926 live smoke** (Unit 19
`_prompt_timing` records):

```
agent-3  attempt=1  25.8s   ok
agent-2  attempt=1  62.1s   ok
agent-1  attempt=1  182.2s  FAIL (headers timeout at cap)
agent-1  attempt=2  182.9s  FAIL (headers timeout at cap)
agent-1  attempt=3   80.8s  ok  ← eventually succeeded
```

Agent-1's first two attempts hit the cap almost exactly — suggesting the
request WOULD have completed in ~185-200 s but we kill it at 180. Unit 24's
planner-fallback didn't trigger because the retries succeeded within the
3-attempt budget.

Notable: the user's direct use of glm-5.1:cloud via Ollama + opencode
(outside our swarm) consistently returns in <30 s. So this is NOT a
fundamental cloud or model issue — it's the N-parallel-cold-start pattern
we create.

**When this would need revisiting:** ongoing — this is the most visible
failure mode in every multi-agent run.

**Fix directions:**

1. Bump `HEADERS_TIMEOUT_MS` 180 → 300 (cheap, one line) so a ~200 s
   legitimate cold-start succeeds instead of burning a retry.
2. Bump retry backoff [4 s, 16 s] → [30 s, 90 s] so retries actually give
   the cloud shard time to warm.
3. More substantive warmup prompt (Unit 17 currently sends "Reply with one
   word: ok" — tiny, doesn't warm the large-context inference path the real
   prompt exercises).
4. Serialize first-prompts across N agents with a small inter-agent delay
   (e.g., 5-10 s stagger) so the cold-start contention is smoothed.

**Update 2026-04-27**: substantially mitigated by `189ca05` (SSE-aware
turn watchdog). The runner-level wall-clock 4-min absolute cap that used
to kill in-flight prompts mid-generation is gone — replaced with 90s
SSE-silence cap + 30 min hard ceiling. Long-tail latency that's still
producing tokens (visible via `AgentManager.getLastActivity` heartbeat)
is no longer aborted. Cold-start prompts that take 60-180s now succeed
naturally as long as SSE chunks keep landing. **V2 makes this irrelevant**:
`USE_OLLAMA_DIRECT=1` skips the opencode subprocess entirely, removing
the whole class of N-parallel-cold-start contention.

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

**Update (Unit 43)**: `wallClockCapMs` IS now a per-run override on the
`/api/swarm/start` route (range: 60s - 8h). `tokenBudget` is also
per-run (`StartBody.tokenBudget`). Only `MAX_COMMITS` and `MAX_TODOS`
remain compile-time constants in `caps.ts`.

---

## OpenCode subprocess remains a runtime dependency (V2 hasn't dropped it yet)

**Choice:** even after the V2 substrate work shipped, every fresh clone
still requires:
- `opencode` CLI on `PATH` as `OPENCODE_BIN` (`.cmd` wrapper on Windows)
- `OPENCODE_SERVER_PASSWORD` set in `.env` (any string — shared secret
  with the spawned subprocesses)
- `npm install` pulls `@opencode-ai/sdk` as a runtime dep

**Why:** V2 dropped opencode for the LLM-call path only (gated behind
`USE_OLLAMA_DIRECT=1`, currently used only by `BlackboardRunner`). The
agent management layer — `AgentManager.spawnAgent` shelling to
`opencode serve --port N` per agent + per-agent `opencode.json` config
+ `session.create`/`session.prompt`/SSE event subscription — still drives
every preset.

**The "orchestrator opencode at port 4096" claim was DELETED 2026-04-27**
along with the `OPENCODE_BASE_URL` env var, `AgentManager.getOrchestratorClient()`,
and the startup log line. Per-agent subprocesses (random ports) ARE used and
remain the only opencode surface in the runner. Sentence kept here for
post-mortem readers tracing why old runs/docs reference port 4096.

**When this would need revisiting:** when shipping a single-binary install
("user just needs Ollama") becomes a goal. Per `ARCHITECTURE-V2.md`:
~1 week of focused refactor — wire `ollamaDirect` through non-blackboard
runners (1d), replace `AgentManager.spawnAgent` with our own session-state
class (3d), delete `opencode.json` writing (2d).

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

## ~~First-pass contract's `expectedFiles` aren't grounded in repo structure~~ (resolved 2026-04-23, Unit 28)

**Status:** fixed. The root cause (planner guesses a plausible path that
doesn't match where workers eventually commit) is unchanged — LLM
planners will still sometimes pick a reasonable-looking anchor that
disagrees with the worker-chosen one. What Unit 28 changes is the
*consequence*: the auditor no longer starves when a declared path
dangles. `resolveCriterionFiles` now unions a criterion's declared
`expectedFiles` with the `expectedFiles` of committed todos linked to
that same criterion (`criterionId === criterion.id`). On the next
audit, both the planner-chosen anchor AND the real-work anchor are
read and shown to the auditor, so a criterion whose declared path
doesn't exist but whose linked commits landed real work at a
different path can verdict `met` on invocation 1 without waiting for
a repath round.

Declared files stay at the head of the resolved list so the
auditor's primary evidence is still the contract-declared paths;
linked files are appended as corroborating evidence. Per-criterion
cap: `declared.length + AUDITOR_FALLBACK_FILE_MAX`. The Unit 5d
fallback for criteria with NO declared files is unchanged.

**Original symptoms (preserved for context):** on the 2026-04-21
medium run (`kevinkicho/multi-agent-orchestrator`, commit `18588b9`),
the contract said `src/brain/team-manager.test.ts` but the actual
module lives at `src/team-manager.ts`. Workers correctly routed
tests to `src/tests/team-manager.test.ts`, the auditor observed the
mismatch on invocation 1, and re-dispatched new todos with
corrected anchors — but the wall-clock cap tripped before audit #2
could assess the repath (~8 of 21.8 min spent on reconciliation).
Three criteria (c1/c2/c3) stayed `unmet` purely because the
original contract path didn't match the file the work landed in.
Under Unit 28, audit #1 would have included both paths in the
readFiles union and could have verdicted `met` without needing a
second invocation.

Keeping the old text below for future archaeology:

&nbsp;&nbsp;&nbsp;&nbsp;_The first-pass contract emits `criteria[].expectedFiles` from
the mission wording. The agent sees a ~200-entry tree dump and the
top-level README during seed, but it doesn't stat the guessed paths or
verify they correspond to where work will actually land. We kept it
cheap and trusted the downstream planner + auditor to reconcile
anchors — Unit 28 is the "auditor reconciles" half of that bet being
paid off._

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
