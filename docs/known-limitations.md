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

## Wall-clock cap uses `Date.now()`, not a monotonic timer

**Choice:** the 20-minute hard cap compares `Date.now() - startedAt`
against `MAX_WALL_CLOCK_MS`. It is not backed by `performance.now()` or
any other monotonic source.

**Why:** `Date.now()` is cheap, obvious, and matches the same clock used
for `startedAt`/`endedAt` in `summary.json` — convenient when correlating
wall-clock with log timestamps. Monotonic timers are harder to reason
about when reporting run duration to a human.

**What this breaks:** if the host sleeps during a run (laptop lid
closed, OS suspend), `Date.now()` jumps forward on resume while the
node event loop was paused. On the next turn-tick, the cap check reads
a wall-clock delta of many hours and the runner immediately stops with
`stopReason: "cap:wall-clock"` and the static `"wall-clock cap reached
(20 min)"` detail string — even though actual work took far less than
20 minutes.

**Evidence:** v7 of phase11c-medium shows `wallClockMs: 31_273_500`
(~8h 41m) with `stopReason: "cap:wall-clock"` and `stopDetail:
"wall-clock cap reached (20 min)"`. The clone directory's last-modified
time matches the ~8h window, and only 5 commits landed — consistent
with the host being suspended overnight. See
`runs/phase11c-medium-v7/comparison-v6-v7.md` for the full post-mortem.

**When this would need revisiting:**
- If unattended overnight runs become the norm (e.g., scheduled E2E
  runs against a queue of repos), every such run will die on resume
  with a misleading stop reason.
- If we start billing token cost against wall-clock elapsed — the
  summary's `wallClockMs` will overstate real work.

**Cheap fix when it becomes a real problem:** track elapsed via
`performance.now()` instead of `Date.now()`, OR detect a large
`Date.now()` jump (>2× the expected turn interval) on each tick and
reset the baseline to "now" with a one-line system note. Either keeps
the cap measuring actual active work.

---

## `RoundRobinRunner.runTurn` has no retry wrapper

**Choice:** `server/src/swarm/RoundRobinRunner.ts` wraps each turn in a
single-shot try/catch around `session.prompt`. Any failure
(`UND_ERR_HEADERS_TIMEOUT`, fetch failure, SDK error) flips the agent
to `failed` and the outer loop moves to the next agent without retry.

**Why:** round-robin is the simple baseline — clean forward progress,
one turn per agent per round, failures visible in the transcript. The
blackboard runner has retry+surfacing logic (`promptAgent` + Unit 7's
retry-state wiring) because its agents do real work that's expensive
to lose; discussion turns are cheap to skip.

**What this breaks:** the `role-diff` preset rides on
`RoundRobinRunner`. The 2026-04-22 role-diff E2E run
(`runs/role-diff-v1/compliance-report.md`) completed with 4 of 5
agents marked `failed` — agents 2–5 hit `UND_ERR_HEADERS_TIMEOUT` on
their first turn and never recovered. Only the Architect (agent 1)
ever spoke. Under the blackboard runner with identical model latency,
those same timeouts would have retried 3× before marking the agent
failed.

**When this would need revisiting:**
- If role-diff (or any future round-robin-based preset) starts being
  used for actual evaluation rather than just "does the preset wire
  up" — a 1-of-5 role-coverage run is worthless for comparing roles.
- If the bounded headers timeout from Unit 7 stops being the dominant
  failure mode; today it's the main reason a first turn fails.

**Cheap fix when it becomes a real problem:** port the retry wrapper
from `BlackboardRunner.promptAgent` into `RoundRobinRunner.runTurn`.
The retry-state surface (retryAttempt / retryMax / retryReason on
`AgentState`) already exists — only the retry loop itself is missing.

---

## `AgentManager.toStates()` reports every agent as `"ready"`

**Choice:** the REST snapshot at `GET /api/swarm/status` calls
`AgentManager.toStates()`, which currently hard-codes
`status: "ready"` for every agent regardless of its actual status.
Status transitions (`thinking`, `retrying`, `failed`, `stopped`)
reach the UI via the `agent_state` WebSocket event instead, which the
in-browser zustand store applies.

**Why:** (unclear — likely a stub from early scaffolding that was
never fixed once `markStatus` started broadcasting). The UI works
because it uses the WebSocket stream; nothing in-app ever consulted
the REST snapshot for per-agent status.

**What this breaks:** any tool polling `/api/swarm/status` for agent
health — e.g. the `scripts/monitor-role-diff.mjs` monitor — will
never see a failed or retrying agent. The role-diff compliance
report came back with `Irregularities: None` despite 12+
`UND_ERR_HEADERS_TIMEOUT` events in the run, because the REST
endpoint served stale `ready` states for the dead agents.

**When this would need revisiting:**
- If any E2E or monitor script relies on REST polling for compliance
  checks. Today the fix is "monitor the transcript contents"; the
  next time someone writes a monitor expecting REST to be
  authoritative, they'll get bitten.
- If an external tool (CI, a Slack bot) wants to check swarm health
  without holding a WebSocket open.

**Cheap fix when it becomes a real problem:** in `toStates()`, read
the status from the same in-memory agent record that `markStatus`
writes to, rather than the literal `"ready"`. One line change in
`server/src/services/AgentManager.ts`.
