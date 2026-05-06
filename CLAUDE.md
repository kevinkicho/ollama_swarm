# CLAUDE.md — entry point for Claude Code in this repo

This file is auto-loaded into every session. Keep it short; link out for depth.

## Read these first (in order)

1. **`docs/STATUS.md`** — what ships today; current V2 substrate status; recent fixes worth knowing about. If this disagrees with code, code wins.
2. **`docs/AGENT-GUIDE.md`** — day-1 essentials: common commands, commit conventions, where new code goes, don'ts, operational hazards.
3. **`docs/active-work.md`** — persistent TODO list across sessions. Per-session task lists die at session end; this is the durable equivalent.
4. **`docs/decisions/`** — 4 active ADRs covering non-obvious "why this and not that" choices (per-agent subprocess history, hunk format, blackboard-only writes, V2 parallel-track rollout). ADR 005 (keep opencode) was superseded 2026-04-29 by E3 Phase 5; the file remains as historical record.

## Two reference docs to know about (don't read cold; reach for when needed)

- **`docs/known-limitations.md`** — what's a deliberate trade-off vs. a bug.
- **`server/src/swarm/blackboard/ARCHITECTURE.md`** — code-near design doc. Read before editing the blackboard directory.

## Conventions specific to this repo

- **Commit author**: `git -c user.name='Kevin' -c user.email='kevinkicho@gmail.com' commit ...` — Kevin's git config isn't always set; pass inline.
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
