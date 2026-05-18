---
name: autoresearch
description: Autonomous research & improvement skill. Use when the user says "autoresearch", "auto-improve", "self-improve", "ratchet", or asks for unsupervised codebase improvement. Operates independently without user supervision, auto-compacting as needed. Works in ambition tiers: stability/maintenance first, then scope/depth expansion.
---

# Autoresearch — Autonomous Codebase Improvement

## Purpose

This skill runs without user supervision. It systematically surveys the entire
codebase, identifies issues and opportunities, then works through them in
increasingly ambitious tiers — a ratchet that never goes backward. It compacts
context automatically when needed.

## Rules

- **No user prompts needed.** Start immediately and continue until all tiers
  are exhausted or until explicitly told to stop.
- **FIRST ACTION: set checkpoint to in_progress.** Before any other work,
  update `.opencode/session-checkpoint.md` Status to `**in_progress**`. The
  auto-resume plugin reads this; without it the loop stops after one batch.
- **Auto-compact.** When context nears exhaustion (high token usage), issue
  `/compact` before continuing. Do not wait for truncation warnings.
- **Commit each atomic piece of work.** After each fix/improvement, verify with
  tests/lint and commit with a descriptive message using the repo's commit
  convention: `git -c user.name='Kevin' -c user.email='kevinkicho@gmail.com' commit`.
- **Update `docs/active-work.md`.** Mark queued items as completed when shipped
  and add a commit hash reference. Remove items that are no longer relevant.
- **Update `.opencode/session-checkpoint.md`** after each significant step so
  recovery is possible if the session crashes.
- **Never commit `.env`, `runs/`, `logs/`, or build artifacts.**
- **Run `npm test` after every code change.** All 2900+ tests must stay green.
  If a test fails, fix it before moving on.
- **Do NOT `npm install` from WSL** (it swaps esbuild binaries and breaks
  Kevin's Windows dev server).
- **Server must stay in the same process tree** as the bash tool — never use
  `nohup`, `disown`, or `setsid`.

## Tiers (in order — do not skip ahead)

### Tier 0: Survey (READ-ONLY)

**Goal:** Build a complete mental model of the project.

1. Read `CLAUDE.md`, `.opencode/session-checkpoint.md`, `docs/STATUS.md`,
   `docs/active-work.md`, `docs/AGENT-GUIDE.md`, `docs/known-limitations.md`,
   `docs/decisions.md`, `docs/changelog.md`, `docs/model-behaviors.md`,
   `docs/swarm-patterns.md`.
2. Read the package.json files at root, `server/`, `web/`, `shared/`.
3. Walk the directory tree: `server/src/`, `web/src/`, `shared/src/`.
   Use glob to list all `.ts` and `.tsx` files.
4. Read key entry points:
   - `server/src/index.ts` — startup, shutdown, port bindings
   - `server/src/routes/swarm.ts` — main API route
   - `server/src/providers/` — all LLM provider implementations
   - `server/src/swarm/` — orchestrator, blackboard, presets
   - `shared/src/` — types, model config, provider utilities
   - `web/src/components/` — UI components (especially `transcript/`)
5. Read `docs/active-work.md` for the current queued todo list.
6. Read `server/scripts/run-tests.mjs` to understand the test harness.
7. Run `git log --oneline -30` to see recent work patterns.

**Deliverable:** You now have a thorough map of the codebase. Summarize your
findings: project purpose, architecture, key modules, test coverage areas,
uncovered areas, obvious debt or bugs.

### Tier 1: Stability & Bug Fixes

**Goal:** Find and fix actual bugs. Ship zero regressions.

1. Re-read `docs/known-limitations.md` and `docs/STATUS.md` — are any listed
   limitations actually bugs that can be fixed now?
2. Grep for `TODO`, `FIXME`, `HACK`, `XXX` in `server/src/` and `web/src/`.
3. Look for: unhandled promise rejections, missing `.catch()` on promises,
   `any` types that should be narrowed, potential runtime crashes from optional
   property access without guards.
4. Check error handling patterns: are all API routes wrapping dynamic imports
   in try/catch? Are all `fetch()` calls guarded? Are all provider calls
   handling the 4xx/5xx/network-error trinity?
5. Check for process lifecycle bugs: are there any timers/intervals without
   cleanup? Any event listeners without `removeListener`? Any dangling file
   handles or sockets?
6. Look for type-safety gaps: `as` casts that could be runtime bombs, Zod
   schemas that accept more than the runtime expects.

**For each bug found:**
- Write a failing test first, then fix it.
- Keep the fix minimal — don't refactor adjacent code.
- Commit with message like `fix: <description>`.

### Tier 2: Test Coverage Expansion

**Goal:** Increase test reliability and coverage in weak areas.

1. Map current test distribution: count tests per file. Identify modules with
   0 tests or <5 tests.
2. Focus on these untested/under-tested areas:
   - `web/src/components/transcript/` (1 test for 63 components — ~1.6%
     coverage)
   - Any provider that only has "smoke test" coverage
   - Utility functions in `shared/src/` that are called by many modules
   - Edge cases in the model resolution pipeline (`resolveModels`)
3. Write tests that exercise:
   - Error paths (network failure, invalid input, timeout)
   - Boundary conditions (empty arrays, null/undefined, very large inputs)
   - Concurrency/race conditions (if applicable)
4. Run the full suite after each batch. All must pass.

### Tier 3: Technical Debt Reduction

**Goal:** Refactor safely — same behavior, better structure.

1. Identify duplicated logic (grep for similar code patterns across files).
2. Find files >500 lines that could be split.
3. Look for inconsistent patterns: some routes using one convention, others
   using another.
4. Check for dead code: exported but never imported symbols, unreachable
   branches.
5. For each refactor:
   - Ensure existing tests still pass unchanged.
   - Add new tests if you're extracting a new function/module.
   - Commit with message like `refactor: <description>`.

### Tier 4: Feature & Scope Expansion

**Goal:** Ship improvements from `docs/active-work.md` queued items, or new
ones you discover.

1. Process queued items in `docs/active-work.md` in priority order.
2. Each item has a trigger phrase (e.g., `go hunk syntax highlighting`). Treat
   these as explicit permission to implement.
3. Before implementing any item not in active-work.md, write it as a new queued
   entry first so there's a record of intent.
4. For each feature:
   - Implement server-side changes first, then client.
   - Add tests.
   - Verify end-to-end with `npm test`.
   - Update `docs/STATUS.md` with the change.
   - Move the item from "Queued" to "Done recently" in active-work.md with a
     commit hash.

### Tier 5: Polish & Documentation

**Goal:** Sharpen what already exists.

1. Check `docs/` for stale references, broken links, or outdated test counts.
2. Verify `CLAUDE.md` still accurately describes the repo.
3. Check for inconsistent naming (e.g., "blackboard" vs "blackboard" in docs).
4. Review recent git log for commits with poor messages — no need to fix them,
   just note for future discipline.
5. Run `npm test` one final time. Confirm the test count.

## Auto-compaction protocol

When the conversation approaches token capacity, instead of summarizing
manually:

1. Run `/compact` — OpenCode will compress the conversation history into a
   summary that preserves key decisions, context, and current state.
2. After compaction, read `.opencode/session-checkpoint.md` to verify state
   was preserved.
3. Continue from where you left off. The compaction preserves your mental
   model of what's done, what's in progress, and what's next.

## Session recovery

If the session crashes (which is common), on the next session start:
1. Read `.opencode/session-checkpoint.md` — it will say "crashed" and list
   what was in progress.
2. Pick up where you left off.
3. Re-read any files you were actively editing.

## When to stop

- **Explicitly told to stop by the user.** This is the ONLY way autoresearch
  stops on its own. Tiers cycle — when one is functionally exhausted, move to
  the next. When all are exhausted, cycle back to Tier 1 for incremental
  improvements. The ratchet never goes backward and never idles.
- **NEVER set the checkpoint to `**finished**`.** Leave it as `**in_progress**`
  unless the user explicitly tells you to stop. The auto-resume plugin
  continues the loop across sessions — finished kills it.
- **Consecutive failures are NOT a stop condition.** If a batch of tests
  fails, fix them and continue. If a tier's work fails 3+ times, skip to the
  next tier and come back later. Never exit the loop.
- **"All queued items done" is NOT a stop condition.** If active-work is
  empty, use the tier instructions to discover new work. There is always
  something to improve.

## Communication

- **Text responses are fine.** Provide brief status updates, summaries, and
  commit messages as needed.
- **Only speak when blocked** — if you hit a decision you can't make (e.g.,
  choosing between two valid approaches), present the options concisely and ask
  which to take.
- **When done with a tier**, briefly note which tier completed and move to
  the next. Keep the checkpoint updated with tier progress.