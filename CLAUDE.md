# CLAUDE.md — entry point for Claude Code in this repo

This file is auto-loaded into every session. Keep it short; link out for depth.

## Read these first (in order)

1. **`docs/STATUS.md`** — what ships today; current V2 substrate status; recent fixes worth knowing about. If this disagrees with code, code wins.
2. **`docs/AGENT-GUIDE.md`** — day-1 essentials: common commands, commit conventions, where new code goes, don'ts, operational hazards.
3. **`docs/active-work.md`** — persistent TODO list across sessions. Per-session task lists die at session end; this is the durable equivalent.
4. **`docs/decisions/`** — 5 short ADRs explaining non-obvious "why this and not that" choices (per-agent subprocess, hunk format, blackboard-only writes, V2 parallel-track rollout, keep opencode).

## Two reference docs to know about (don't read cold; reach for when needed)

- **`docs/known-limitations.md`** — what's a deliberate trade-off vs. a bug.
- **`server/src/swarm/blackboard/ARCHITECTURE.md`** — code-near design doc. Read before editing the blackboard directory.

## Conventions specific to this repo

- **Commit author**: `git -c user.name='Kevin' -c user.email='kevinkicho@gmail.com' commit ...` — Kevin's git config isn't always set; pass inline.
- **Test command**: `OPENCODE_SERVER_PASSWORD=test-only npm test` — the prefix is required (zod-validated config; without it 47 tests fail at module load).
- **Don't push without explicit user approval.** This is a solo repo with a public mirror — Kevin reviews diffs before they leave the machine.
- **Don't `npm install` from WSL.** It swaps esbuild binaries and breaks Kevin's next Windows dev-server. See `feedback_wsl_windows_esbuild` in memory.

## Where memory lives

User-level memory at `~/.claude/projects/-mnt-c-Users-kevin-Desktop-ollama-swarm/memory/` is auto-loaded into context. The `MEMORY.md` index there is the table of contents.
