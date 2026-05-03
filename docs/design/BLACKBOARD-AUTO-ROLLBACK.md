# Blackboard auto-rollback — design draft (DEFERRED-WITH-MODULE)

**Status**: PROPOSAL · 2026-05-02 · awaiting Kevin's nod on the 6 open
decisions before wiring the existing `todoRollback.ts` module into the
worker pipeline.

`server/src/swarm/blackboard/todoRollback.ts` ships today with the
`shouldRollback` decision rule + a `git reset --hard` wrapper. This
doc covers what's MISSING for safe integration.

## What auto-rollback would do

When a criterion comes back FALSE from the auditor, automatically run
`git reset --hard <parent-of-first-todo-commit>` to unwind just-that-
todo's commits. Keeps the working tree clean for partial-success runs
where the user wants to cherry-pick the good stuff.

## Why it's not simply "wire it in"

Auto-modifying git state during a live multi-agent run is a
foot-gun-rich domain. The existing worker pipeline produces commits
non-deterministically (parallel workers, retries, hunk-repair), and
rollback needs precise attribution to avoid wiping unrelated work.
The module exists; the wiring requires answers to 6 open decisions.

## Open decisions (need Kevin's call)

### 1. Criterion → todo → commit attribution

**Today**: We track `commitSha` per `applyAndCommit` call, and we
track `todo.id` per worker invocation. But `todo.expectedFiles` are
the only signal linking a todo to a criterion (criteria carry
`expectedFiles[]` too). The mapping is many-to-many — multiple todos
can target the same criterion file; one todo can satisfy multiple
criteria.

**Decision needed**: Do we (a) track `Map<todoId, criterionId[]>` at
plan-time, populated by the planner explicitly tagging each todo with
the criterion(s) it serves; or (b) infer attribution post-hoc by
intersecting `todo.expectedFiles ∩ criterion.expectedFiles`?

**Recommendation**: (a) explicit. Inference is fragile when todos
touch overlapping files. ~30 LOC added to the planner contract +
~20 LOC to the worker queue to carry the tag through.

### 2. Rollback scope — what's the unit

**Options**:
- (a) **Per-todo**: roll back just the failed todo's commits. Other
  todos for the same criterion stay. Surgical but may leave the
  criterion in a half-state.
- (b) **Per-criterion**: roll back ALL commits attributed to the
  failed criterion. Cleaner end-state but unwinds more work.
- (c) **Per-run**: roll back EVERY commit when ANY criterion fails
  hard. Safest for "I want a clean cherry-pick experience" but
  defeats the partial-success workflow.

**Recommendation**: **(b) per-criterion**. Matches the auditor's
unit-of-judgment. Per-todo leaves orphan partial work; per-run is
too blunt.

### 3. Concurrency safety

Multiple workers commit in parallel. If worker-A commits to criterion-1
at SHA-X and worker-B commits to criterion-2 at SHA-Y (Y is child of X
because git is linear), and we want to roll back criterion-1 (SHA-X),
we'd be rolling back BOTH X and Y because git history is linear.

**Decision needed**: When a rollback unwinds Y as collateral, do we
(a) refuse the rollback + log "criterion 1 has dependencies"; (b)
roll back both + re-enqueue criterion-2's todos for replay; or (c)
serialize commits per-criterion via a temporary branch per criterion +
merge-on-success?

**Recommendation**: **(a) refuse + log** for the first cut. (b) is
correct but expensive (re-runs work); (c) is the cleanest design but
requires a substantial git-workflow change. (a) keeps the surface
small and forces the user to manually intervene when there's a
dependency — annoying but safe.

### 4. User-stop / cap-trip behavior

If the user pressed Stop OR the wall-clock cap fired AND there's an
unmet criterion, should auto-rollback fire?

**Decision needed**: (a) NEVER on user-stop or cap-trip — the user
wants their progress preserved, even if partial; or (b) fire on
cap-trip but not user-stop (cap-trip means we couldn't finish and
should clean up); or (c) always fire if `shouldRollback` says so.

**Recommendation**: **(a) NEVER on user-stop or cap-trip**. Both are
"the user wanted out" signals; auto-deleting their work is the wrong
default. The user can manually rollback via the deliverable's
"rollback suggestions" section.

### 5. Opt-in / opt-out

**Decision needed**: Default-on with `cfg.autoRollback: false` opt-out,
or default-off with `cfg.autoRollback: true` opt-in?

**Recommendation**: **default-OFF** (`cfg.autoRollback?: boolean`,
defaults to `false`). New behavior that destroys work should be
explicit. Once we have months of data on false-positive rate, can
flip to default-on.

### 6. Audit trail

When rollback fires, what gets recorded?

**Recommendation**: ALL of:
- Transcript entry: `[auto-rollback] Criterion c2 verdict=false → reset HEAD to <parent SHA>; commits unwound: SHA1, SHA2`
- Summary.json field: `autoRollbacks: [{criterionId, resetTo, commitsUnwound: [], reason}]`
- Deliverable section: "Auto-rollbacks fired" with the same data
- New `kind: "auto_rollback"` on TranscriptEntrySummary

## Required code changes (post-decision)

Assuming the recommended answers:

1. **Planner prompt change** — add `criteria?: string[]` to PlannerTodo schema; planner explicitly tags each todo with the criterion(s) it serves. ~40 LOC + tests.
2. **Worker queue tag carry-through** — TodoQueue stores the tag on each entry; worker passes it through to applyAndCommit. ~30 LOC + tests.
3. **Per-criterion commit tracking** — BlackboardRunner adds `private commitsByCriterion: Map<string, string[]>`; populated in `executeWorkerTodo` after applyAndCommit success. ~20 LOC + tests.
4. **Auditor-driven rollback hook** — after each auditor verdict pass, for each criterion with verdict===false, check `cfg.autoRollback`; if true AND not user-stop AND not cap-trip, look up commits, check for collateral via #3's refuse-on-dependency rule, fire `rollbackTodoCommits`, record audit trail. ~80 LOC + tests.
5. **Deliverable section update** — add "Auto-rollbacks fired" section to writeBlackboardDeliverable; pulls from this.autoRollbacks. ~30 LOC.
6. **TranscriptEntrySummary kind** — add `auto_rollback` variant for UI rendering. ~15 LOC.

**Total estimate**: ~215 LOC + ~120 LOC tests + 1 careful test pass through a real multi-criterion blackboard run to verify the dependency-detection works. **2-3 hour focused session.**

## What the user does in the meantime

Without the auto wiring, today's deliverable already includes the
data needed for manual rollback:
- Per-commit table with SHA prefixes
- Auditor per-criterion verdicts

A user wanting a clean tree can:
```bash
# From the deliverable's PR section, identify commits attributed to
# the failed criterion. Then:
git log --oneline --since="<run-start>"  # see the swarm's commits
git reset --hard <parent-sha>            # unwind everything since
# OR
git revert <bad-sha>                     # surgical undo without history rewrite
```

Less convenient than auto-rollback but works today.

## Concrete next step

Kevin reviews the 6 decisions above + answers (or accepts the
recommendations). Then phase 1 starts: planner prompt change + tag
carry-through (foundation for everything else).
