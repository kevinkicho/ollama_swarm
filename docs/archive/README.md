# docs/archive — historical material

Files in this directory are preserved as archaeology — they were
useful while in flight but are no longer the current source of truth
for any active design decision. They are not deleted because:

- Linking back to commit messages, PRs, or root-cause discussions
  sometimes requires the journal context that's NOT in `git log`.
- Old run summaries help explain why current safeguards exist.

If you're working on the codebase today, you almost certainly want
[`../STATUS.md`](../STATUS.md) instead.

## What's here

| File | What | When |
|---|---|---|
| `blackboard-changelog.md` | Per-phase journal of every Unit / Phase / Wave that landed in the blackboard build. ~3,986 lines, 206KB. Authoritative source moved to `git log`; this remains for narrative archaeology. | 2026-04 (most recent entries) back through pre-Unit-1 |
| `smoke-tour-2026-04-25.md` | One-off log of a 5-preset smoke tour run on 2026-04-25. Findings rolled into `swarm-patterns.md`, `known-limitations.md`, and the V2 fix wave. | 2026-04-25 |
