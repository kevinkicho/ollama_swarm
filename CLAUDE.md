# CLAUDE.md — entry point for Claude Code in this repo

This file is auto-loaded into every session. Keep it short; link out for depth.

## Read these first (in order)

1. **`.opencode/session-checkpoint.md`** — what shipped last session, known remaining items, test counts. This is the authoritative record of current state. **Always cross-reference against this before diagnosing any problem.** If a bug is listed here as "Done", verify the code has the fix; if listed as "Known remaining", don't re-explore it.
2. **`docs/STATUS.md`** — what ships today; current V2 substrate status; recent fixes worth knowing about. If this disagrees with code, code wins. Includes the maintenance log and test counts.
3. **`docs/AGENT-GUIDE.md`** — day-1 essentials: common commands, commit conventions, where new code goes, don'ts, operational hazards.
4. **`docs/active-work.md`** — persistent TODO list across sessions. Per-session task lists die at session end; this is the durable equivalent.

## Two reference docs to know about (don't read cold; reach for when needed)

- **`docs/known-limitations.md`** — what's a deliberate trade-off vs. a bug.
- **`docs/model-behaviors.md`** — model-specific quirks, reliability, and role recommendations (empirical, from production runs).
- **`docs/decisions.md`** — 5 ADRs covering non-obvious "why this and not that" choices (per-agent isolation, hunk format, write-capable preset boundary, V2 parallel-track rollout, opencode removal).
- **`docs/changelog.md`** — all notable changes reverse-chronological, plus maintenance log.
- **`server/src/swarm/blackboard/ARCHITECTURE.md`** — code-near design doc. Read before editing the blackboard directory.

## Git

- **Commit author**: `git -c user.name='Kevin' -c user.email='kevinkicho@gmail.com' commit ...` — Kevin's global git config isn't always set. The `-c` flags set identity per-commit without modifying global config. A bare `git commit` without `-c` will fail with "Author identity unknown" unless you've set `user.name` and `user.email` globally or in this repo's `.git/config`. When making commits in this repo, always pass `-c user.name='Kevin' -c user.email='kevinkicho@gmail.com'`.
- When staging, add ONLY files relevant to the change. Avoid accidentally committing `.env`, `runs/`, `logs/`, or build artifacts.

## Conventions specific to this repo

- **Test command**: `npm test` from any shell, any cwd. The runner shim (`server/scripts/run-tests.mjs`) sets `OPENCODE_SERVER_PASSWORD=test-only` if not already set. The bash-only `OPENCODE_SERVER_PASSWORD=test-only npm test` prefix is no longer needed (was: until 2026-04-27 commit `0b3cda6`).

- **Don't `npm install` from WSL.** It swaps esbuild binaries and breaks Kevin's next Windows dev-server. See `feedback_wsl_windows_esbuild` in memory.

## Where memory lives

User-level memory at `~/.claude/projects/-mnt-c-Users-kevin-Desktop-ollama-swarm/memory/` is auto-loaded into context. The `MEMORY.md` index there is the table of contents.

## Crash recovery (session checkpoint)

Sessions crash frequently. Two layers preserve in-progress state:

**Automatic (opencode plugin):** The `SessionCheckpointPlugin` at
`~/.config/opencode/plugins/session-checkpoint.ts` hooks into session
lifecycle events (`session.created`, `session.idle`, `session.error`,
`tool.execute.after`, `file.edited`) and automatically writes
`session-checkpoint.json` + `session-checkpoint.md` to `.opencode/`
in the project root (also mirrors to the `.claude/projects/` memory
directory for backward compat). On crash (SIGTERM/SIGINT/beforeExit),
it writes immediately. On session start, it marks the previous session
as `crashed` and injects the checkpoint into the new session via a
`noReply` prompt. The `opencode.json` instructions list includes
`.opencode/session-checkpoint.md` so it's auto-loaded into context.

**Manual fallback:** During complex work, after each significant step
(file edit, test run, commit), also update
`.opencode/session-checkpoint.md` with: current task, done steps, next
steps, blocked items, partial state. On session start, if that file
exists with status "crashed", read it and offer to resume. This is
lightweight — not a replacement for `docs/active-work.md` (which tracks
durable queued/shipped work).
