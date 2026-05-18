---
name: autoresearch
description: Autonomous research & improvement skill. Use when the user says "autoresearch", "auto-improve", "self-improve", "ratchet", or asks for unsupervised codebase improvement. Operates independently without user supervision, auto-compacting as needed. Works in ambition tiers: stability/maintenance first, then scope/depth expansion.
---

# Autoresearch — Autonomous Codebase Improvement

## Purpose

This skill runs without user supervision. When loaded, it works through a
series of improvement tiers using tool calls — editing files, running tests,
committing changes — without producing any text response. It only speaks when
context is exhausted (then re-compacts and continues) or when explicitly told
to stop.

## Critical: Single-Session Loop

- **NEVER produce a text response.** Your response should be EMPTY or contain
  only the next "autoresearch" trigger. All communication happens through
  tool calls. A text response ends the session — avoid it at all costs.
- **Use tools in a continuous loop.** After each piece of work (edit + test +
  commit), immediately start the next piece of work. Do not summarize, do not
  report progress, do not produce any text.
- **Auto-compact when needed.** When context approaches token limits, the
  auto-compaction system handles it. Continue working after compaction.
- **The session IS the loop.** No plugin, no watchdog, no subprocess needed.
  Tool calls keep the session alive; text responses kill it.

## Rules

- **Commit each atomic piece of work.** After each fix/improvement, verify
  with tests and commit: `git -c user.name='Kevin' -c user.email='kevinkicho@gmail.com' commit`.
- **Update `docs/active-work.md`.** Mark queued items as completed when
  shipped. Remove items no longer relevant.
- **Never commit `.env`, `runs/`, `logs/`, or build artifacts.**
- **Run `npm test` after every code change.** All 2900+ tests must stay green.
- **Do NOT `npm install` from WSL** (swaps esbuild binaries).
- **Server must stay in the same process tree** — never `nohup`/`disown`/`setsid`.

## Tiers (cycle through — never skip, come back if skipped)

### Tier 0: Survey (if never done before)
Build mental model by reading docs, entry points, running `git log -30`.

### Tier 1: Stability & Bug Fixes
Find actual bugs. Write failing test, fix, commit. Check: unhandled promises,
missing `.catch()`, `any` types, runtime crashes, process lifecycle leaks.

### Tier 2: Test Coverage Expansion
Identify modules with 0 or <5 tests. Write tests for error paths, boundary
conditions, edge cases. Focus on pure functions in shared/src/ and web/src/
utility files.

### Tier 3: Technical Debt Reduction
Remove dead code, consolidate duplicate imports, delete re-export shims,
split files >500 lines, remove unused barrel exports.

### Tier 4: Feature & Scope Expansion
Ship improvements from `docs/active-work.md` queued items that have explicit
triggers.

### Tier 5: Polish & Documentation
Update outdated test counts in docs, verify CLAUDE.md, check for stale
references, confirm test count with `npm test`.

## When to stop

- **Context exhausted + compaction failed** — produce a brief text response
  with "autoresearch" so the next session continues.
- **Explicitly told to stop by the user.**
- **All tiers genuinely exhausted** (no meaningful work left after cycling
  through all tiers 3+ times).

## Communication

- **NO TEXT RESPONSES.** Only use tool calls.
- **When context is exhausted**, produce exactly one text response:
  "autoresearch" — nothing else. This triggers the next session.
- **If blocked** (unsure which approach), present options concisely, ask which
  to take, and continue working.