# ADR 003 — Blackboard is the only write-capable preset

**Status:** accepted
**Decided:** Unit 20 era; reaffirmed across multiple validation tours
**Last verified:** 2026-04-27

## Decision

Of the 8 swarm presets that ship, only `blackboard` modifies files
in the cloned repo. The other 7 (round-robin, role-diff, council,
orchestrator-worker, orchestrator-worker-deep, debate-judge,
map-reduce, stigmergy) are discussion-only — they read files via
the `swarm-read` agent profile but cannot edit, write, or shell.

## Context

The presets were originally going to fan out — every pattern would
get a write-capable variant ("council-write", "debate-write", etc.).
After shipping blackboard's CAS + atomic-todo + stale-replan
machinery, it became clear that the *coordination* layer (not the
model) was the hard part. Discussion presets are useful as
analyzers / specifiers / debaters; their output flows into a human
or into a write-capable preset later.

## Alternatives considered

1. **All presets write-capable.** Each would need its own
   coordination story: how do N orchestrator-workers commit without
   stomping each other? How does a council reconcile diffs across
   N drafters? Designing those is a multi-week project per preset.
   We didn't have appetite without evidence one of them is needed.

2. **Blackboard only writes (this ADR).** Other presets stay
   discussion. If a user wants writes from "council-style" thinking,
   they run council to produce the consensus, then run blackboard
   with the consensus as `userDirective`.

3. **Add a "verify" step to discussion presets that emits patches.**
   Doable but the verifier turns into a single-agent blackboard
   anyway. Not worth the abstraction inversion.

## Trade-offs

- **Win:** complexity stays bounded. One hard problem (atomic
  multi-worker commits) solved well, in one place.
- **Limit:** a user who wants "debate-judge writes the winning
  side's argument as a real patch" has to run debate-judge first,
  then blackboard. Not a single-call workflow.
- **UX:** the start form has an `executeNextAction: true` opt-in for
  debate-judge that adds a post-verdict "build phase" — a narrow
  exception that makes Pro the implementer. This is
  blackboard-pattern logic running inside debate-judge for one
  round, not a true write-capable variant.

## When to revisit

- If a specific discussion preset routinely produces output that
  *should* land as code and the manual "run blackboard with the
  output as directive" becomes painful enough to justify writing
  that preset's coordination story.
- If we add a 9th preset designed write-first.

## References

- `server/src/swarm/{Council,Debate,...}Runner.ts` — every non-blackboard
  runner uses `agentName: "swarm-read"` (read tools only)
- `server/src/services/RepoService.ts:writeOpencodeConfig` — the
  `swarm-read` agent profile sets `tools.{edit,bash,patch,write}: false`
- `docs/swarm-patterns.md` — per-preset design notes
- The post-verdict-build-phase exception lives in
  `DebateJudgeRunner.runBuildPhase` (commit batch around #102)
