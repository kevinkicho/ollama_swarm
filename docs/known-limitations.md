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
