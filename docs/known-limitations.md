# Known Limitations

Deliberate trade-offs in the current build. Each entry names the choice, why
we made it, and what would force us to revisit. Anything that becomes a
*real* problem in practice should graduate out of here into a plan item.

---

## Planner has ALL tools disabled (`swarm` profile, not `swarm-read`)

**Choice:** blackboard's planner and auditor share the `swarm` agent profile
with the workers. That profile has `read: false, grep: false, glob: false,
list: false` and `permission: { edit: deny, bash: deny }`. So the planner
produces its contract with ZERO file inspection — it works only from the
PlannerSeed (repoUrl + topLevel entries + `listRepoFiles` output of 150 paths
+ README excerpt first 4000 chars). The auditor likewise only sees the
specific files named by each criterion's `expectedFiles`, never the
surrounding code.

**Why it happened:** Unit 20 introduced the `swarm-read` profile (read tools
ON, write tools OFF) for discussion presets. Blackboard's planner was left
on `swarm` by default — workers MUST be on `swarm` (they must return JSON
diffs, not call edit tools directly), but the planner has no such constraint.

**When this would need revisiting:** as soon as we want ambitious contracts.
The ambition ratchet can't climb meaningful tiers if every tier's planner is
blind to the code.

**Fix direction:** route the planner + auditor prompts with `agent: "swarm-read"`
instead of `agent: "swarm"`, and update their prompts to explicitly instruct
tool use. Workers stay on `swarm`.

---

## Planner does double duty as the replanner

**Choice:** when a todo goes stale, the **planner agent** handles the replan.
We do not spawn a dedicated replanner agent.

**Why:** the planner already has the repo context loaded and a system prompt
that understands the todo shape. Reusing it keeps agent count stable and
token usage low.

**When this would need revisiting:**
- If we want the replanner to run on a different model or with different parameters.
- If the planner's system prompt needs to specialize so hard in one direction that it starts producing worse replans.
- If we hit token-budget pressure where sharing one agent's context across planning and replanning causes context bloat.

Until any of those bite, one agent covers both roles.

---

## Multi-tenant cost attribution gap

`tokenTracker.setCurrentPreset` is process-global; concurrent runs from
`SWARM_MAX_CONCURRENT_RUNS > 1` interleave at the bucket level. Acknowledged
in `Orchestrator.stopRun`. Would need per-run token buckets to fix.