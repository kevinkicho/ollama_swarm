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

## Planner/auditor can put directory paths in `expectedFiles`

**Choice:** `expectedFiles` on a todo is typed as `string[]` with no
validation that each entry resolves to a file (not a directory). When a
worker hashes the paths at claim time, a directory entry trips
`EISDIR: illegal operation on a directory, read` and the todo goes stale.
The replanner then revises or skips it.

**Why:** this isn't design — it's a gap. Zod validates shape and path
safety (repo-relative, no `..`) in `server/src/swarm/blackboard/resolveSafe.ts`
but stops short of statting the path. The system prompts for planner and
auditor both say "repo-relative file paths" but neither enforces file-vs-dir
because LLMs interpret "path" loosely (`src/`, `__tests__/`, and
`src` all showed up in the smoke run for Phase 11c on
`kevinkicho/kBioIntelBrowser04052026`).

Current behavior is *noisy but safe*: the hash call fails fast, the todo is
marked stale with a clear reason, the replanner picks it up and either
narrows to a real file or skips. The run still makes forward progress.

**When this would need revisiting:**
- If the noise makes the transcript hard to read (Phase 11c run showed 7+
  stale events purely from directory-path todos).
- If a future preset uses `expectedFiles` for something other than hashing
  (e.g., scoping a shell command), where a directory entry would have
  different failure modes.
- If replan budget becomes tight — each directory-path stale burns one of
  the 3 replan attempts on that todo.

Until then, the cheap fix is a system-prompt sharpening in planner.ts and
auditor.ts saying "file paths only, never directories — if you mean to
touch everything under `src/lib/`, name the specific files" plus a
Board-side validation that rejects entries ending in `/`. Both are small
follow-ups, not plan items.
