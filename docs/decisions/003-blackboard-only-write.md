# ADR 003 — Blackboard is the only write-capable preset

**Status:** superseded (2026-05-04 Phase 1 writeMode rollout)
**Decided:** Unit 20 era; reaffirmed across multiple validation tours
**Superseded by:** `cfg.writeMode` + `cfg.writeModel` infrastructure
**Last verified:** 2026-05-04

## Original Decision

Of the 8 swarm presets that shipped in the initial release, only `blackboard` 
modified files in the cloned repo. The other 7 (round-robin, role-diff, 
council, orchestrator-worker, orchestrator-worker-deep, debate-judge,
map-reduce, stigmergy) were discussion-only — they read files via
the `swarm-read` agent profile but cannot edit, write, or shell.

## Why This Changed

**Phase 1 (2026-05-04)** introduced `cfg.writeMode` and `cfg.writeModel` 
infrastructure that enables all discussion presets to opt into writes:

1. **writeMode: "none" (default)** — discussion-only, no file writes. 
   Preserves backward compatibility.

2. **writeMode: "single"** — synthesizer produces hunks directly after 
   multi-agent discussion completes. Uses the new `synthesizerHunks.ts` 
   module with `buildSynthesizerHunksPrompt` + `runSynthesizerHunksAndApply`.

3. **writeMode: "multi"** — each agent can propose hunks during their turn;
   preset-specific reconciliation (vote/judge/pick/merge) at end. 
   Future work (Phase 2+).

## Implementation Details

### Phase 1 (single writer mode)

- **RunConfig extensions**: `writeMode?: "none" | "single" | "multi"` and 
  `writeModel?: string`
- **Infrastructure**: `synthesizerHunks.ts` module with:
  - `buildSynthesizerHunksPrompt()` — prompts synthesizer to emit hunks
  - `parseSynthesizerHunks()` — parses `{ hunks: [...] }` envelope
  - `runSynthesizerHunksAndApply()` — orchestrates prompt + apply
- **Extension to wrapUpApplyPhase**: `hunksFromSynthesizer` field allows
  passing pre-computed hunks directly
- **Discussion context**: Each runner passes its synthesis + relevant files
  to `maybeRunWrapUpApply()` for the synthesizer-hunks path

### Presets Updated

- **Council**: Synthesis lead produces hunks from council consensus
- **MoA**: Aggregator produces hunks from multiple proposer drafts
- **Map-reduce**: Reducer produces hunks from mapper findings
- **Debate-judge**: Judge produces hunks based on winning side
- **Round-robin**: Lead produces hunks from rotating disposition synthesis
- **Role-diff**: Specialist synthesis produces hunks for `deliverable.md`

### Why This Approach

1. **Preserves preset character**: Council still debates. MoA still 
   aggregates. The write phase is additive AFTER discussion completes.

2. **Shared infrastructure**: All runners use the same `synthesizerHunks` 
   module, so improvements benefit all presets.

3. **Single point of failure (acceptable)**: One synthesizer = one commit.
   Simpler than multi-writer coordination. For more complex workloads,
   users should use `blackboard` preset.

4. **Opt-in default OFF**: Existing behavior unchanged. Users must set
   `cfg.writeMode: "single"` or `cfg.executeNextAction: true`.

## Alternatives Considered (Original ADR)

1. **All presets write-capable from the start.** Each would need its own
   coordination story: how do N orchestrator-workers commit without
   stomping each other? Too much initial complexity.

2. **Blackboard only writes (original decision).** Other presets stay
   discussion. If a user wants writes from "council-style" thinking,
   they run council to produce the consensus, then run blackboard
   with the consensus as `userDirective`.

3. **Add a "verify" step to discussion presets that emits patches.**
   Doable but the verifier turns into a single-agent blackboard
   anyway. Not worth the abstraction inversion.

## Future Work

### Phase 2 — Multi-writer mode (writeMode: "multi")

Each preset needs its own reconciliation strategy:

| Preset | Multi-writer strategy |
|--------|----------------------|
| Council | Per-round vote on hunks (extend `councilReconcile`) |
| MoA | Aggregator picks best proposer's hunks |
| Map-reduce | Reducer reconciles cross-slice conflicts |
| Debate-judge | Judge picks winner's hunks |
| OW/OW-Deep | Claim + CAS on file hashes (blackboard-style) |
| Round-robin | Sequential commit OR final-round hunk voting |
| Stigmergy | File-based isolation (already spreads across repo) |

**Infrastructure needed:**
- Hunk reconciliation module (`reconcileHunks.ts`)
- Conflict detection (reuse `applyHunks` search-anchor failure)
- Per-preset conflict policies (`retry | skip | ask-user`)

### Phase 3 — Tool dispatcher writes

New agent profile `swarm-write` that allows agents to call a 
`propose_hunks` tool during their turn (not just synthesizer at end):

```typescript
"swarm-write": {
  read: "allow",
  grep: "allow",
  glob: "allow",
  list: "allow",
  bash: "allow",
  propose_hunks: "allow",  // returns { hunks: [...] }
}
```

 Dispatcher validates + applies hunks, detects conflicts.

## References

- `server/src/swarm/SwarmRunner.ts` — `writeMode` + `writeModel` config
- `server/src/swarm/synthesizerHunks.ts` — synthesizer-hunks infrastructure
- `server/src/swarm/wrapUpApplyPhase.ts` — `hunksFromSynthesizer` extension
- `server/src/swarm/{Council,Moa,MapReduce,DebateJudge,RoundRobin}Runner.ts` — 
  per-preset write phase integration
- `docs/STATUS.md` — updated preset table with write-capable column