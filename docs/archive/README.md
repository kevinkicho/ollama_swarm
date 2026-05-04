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
| `subtask-migration-postmortem.md` | Proposed `SubtaskPartInput` migration. Smoke test (2026-04-28) showed the approach didn't yield the expected structured output; plan was explicitly NOT executed. Kept as historical "this avenue was explored + ruled out" so future contributors don't re-try the same path. (Originally filed as `subtask-migration-plan.md`; renamed to `-postmortem` 2026-05-04 since "plan" implies pending implementation.) | 2026-04-28 |

## Recently deleted (2026-05-04 doc cleanup)

These plans were fully shipped + the implementation IS the truth, so
the plan files added no operational value going forward:

- `blackboard-plan.md` — preset shipped; superseded by [`server/src/swarm/blackboard/ARCHITECTURE.md`](../../server/src/swarm/blackboard/ARCHITECTURE.md) + the changelog above
- `E3-drop-opencode-plan.md` — every phase shipped (commits `d189f0d` → `4190afe`); runtime is provider-direct
- `BLACKBOARD-AUTO-ROLLBACK.md` — `cfg.autoRollback` shipped via `BlackboardRunner.runAutoRollbacks`
- `MOA-TOOL-DISPATCH.md` — Option A shipped via `cfg.moaProposerTools` opt-in
- `MULTI-TENANT-RUNS.md` — all 8 server + client phases shipped 2026-05-04
- `PRESET-LEVERS-DEFERRED.md` — every listed item shipped end-to-end; per-lever docs live in cfg-field JSDoc + helper file headers
- `REMAINING-HEAVY-ITEMS-IMPLEMENTATION.md` — 4 heavy-substrate items shipped (parallel-clone baseline, parallel debate streams, in-flight parallel hypothesis, adaptive worker pool)
- `ui-coherent-fix-package.md` — 3 UI fixes shipped via commit `6dfd470`
