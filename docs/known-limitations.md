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
