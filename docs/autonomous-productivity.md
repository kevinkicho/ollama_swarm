# Autonomous productivity — roadmap

## North star

Make this swarm framework drive **multi-hour, multi-tier autonomous improvement** of
GitHub projects. The swarm should:

- Keep going — not terminate at the first "all criteria met" signal when there's
  cloud budget left.
- Get more ambitious over time — every round of completion should be followed by
  a harder round, not a victory lap.
- Resist token waste — no pyramids of near-identical tests, no dead
  documentation, no rename-for-the-sake-of-rename refactors.

Why this matters: today's `glm-5.1:cloud` model often has better taste for
"what would actually improve this repo" than Kevin can articulate in real time.
The framework's job is to get out of its own way and let the model iterate.

## Known failure modes

1. **Premature "all criteria met" termination.** _Observed on Hello-World
   smoke 2026-04-23:_ a tidy 5-criterion contract completed in ~3 min. Audit
   said "all met"; run ended. Plenty of budget left, nobody telling the
   swarm "now do something harder."

2. **Test-pyramid busywork.** _Hypothesized._ Under pressure to satisfy a
   coverage-flavored criterion, workers produce `foo.test.ts` /
   `foo.bar.test.ts` / `foo.baz.test.ts` with near-identical bodies. The
   auditor accepts the file changes. Criterion "met" despite zero
   information gain.

3. **Flat ambition.** The run's mission statement is frozen at turn 0. The
   auditor can _add_ criteria but can't rewrite scope. No mechanism pushes
   the run's ambition upward across its lifetime.

4. **Outside-world blindness.** Work is judged by file contents. "Does the
   deployed app do what the README claims?" has no signal today. Unit 26's
   Playwright MCP profile exists but no caller wires it.

5. **Rubber-stamp auditing.** Auditor can verdict "met" on criteria that
   were never really worked on (related history in
   `docs/known-limitations.md` — Unit 11 tightened the surrender path, but
   not the rubber-stamp path).

## Leverage points (ranked by depth × payoff)

**(A) Ambition ratchet: tier-climb on completion.** When all criteria meet,
don't terminate — run a "next tier" contract generation that asks _"what
would a great maintainer do NEXT, more ambitious than this tier?"_ The run
climbs tiers (polish → structure → capabilities → research-driven) until a
cap trips. Most direct answer to the north star. **→ Unit 34.**

**(B) Critic agent at commit time.** Before a diff lands, a second agent
judges "substantive or busywork?" Rejected diffs don't land — the todo
goes stale and the planner has to find a better angle. Adds one prompt
per commit, but directly suppresses test-pyramid garbage. **→ Unit 35 (planned).**

**(C) Outside-world grounding via Playwright MCP.** Auditor criteria
phrased as "feature works" get verified by a `swarm-ui` agent navigating
the running app. Unit 26 infrastructure is ready; no caller wires it
yet. **→ Unit 36 (planned).**

### Tactical / sprinkle-in levers

- Prompt rotation — variance-reducing but doesn't change the structural
  dynamic. OK to weave into (A) and (B) for phrasing diversity.
- Tier-specific role catalogs — tier 1 weights docs-reader heavy; tier 3
  weights architect + security heavy. Composes with Unit 32's role editor.
- Cross-run memory — tier climb where run 2 starts from run 1's end-state.
  Aligns with Unit 31's state snapshot.

### Deliberately deferred

- Full RL feedback loop. Over-engineered for the current scale.
- Human-in-the-loop approval gates. Contradicts the "autonomous" frame —
  Kevin trusts the model to drive here.
- Predefined rigid tier schema ("always docs → tests → features"). Too
  rigid; let the planner improvise the next tier from the current state.

## Roadmap

| Unit | Title                                       | Status                         |
|------|---------------------------------------------|--------------------------------|
| 34   | Ambition ratchet: tier-climb on all-met     | shipped (`f3314ed`, 2026-04-23)|
| 35   | Critic agent at commit time                 | shipped (`469ef62`, 2026-04-23)|
| 35-fix | Critic uses fresh session on planner      | shipped (`e258d2f`, 2026-04-23)|
| 36   | Wire `swarm-ui` (Unit 26) to auditor        | shipped (`e22e337`, 2026-04-23)|
| 37   | Planner + auditor use `swarm-read` profile  | shipped (`5473694`, 2026-04-23)|
| 38   | Agent-lifecycle control + orphan reclamation| shipped (`b103dc7`, 2026-04-23)|
| 39   | Timeout + retry + "thinking 3m54s" UX        | shipped (`d7cd59a`, 2026-04-23)|
| 40   | Historical latency graph in thinking tooltip | shipped (`3ee9408`, 2026-04-23)|
| 41   | Stop endpoint awaits verified kill           | shipped (`e71dd84`, 2026-04-23)|
| 42   | Per-agent model selection (planner vs worker)| shipped (`542a273`, 2026-04-23)|
| 43   | Per-run wall-clock cap override              | shipped (`32da3b5`, 2026-04-23)|
| 44b  | Anchor-windowed worker seed (middle-row fix) | shipped (`6185a4a`, 2026-04-23)|
| 45   | Per-file claim priority / row-range splits  | planned                        |
| 46   | Per-model timeout + audit-context truncation| planned                        |
| 47+  | Cross-run resume + tier-aware replay        | hypothesized                   |
| 47+  | Auto-start app (workers execute shell)      | hypothesized                   |
| 47+  | Persistent swarm-ui across audits           | hypothesized                   |

## Unit 34 — Ambition ratchet (spec-lite)

**Trigger.** The auditor verdicts "all unmet criteria are now met" AND the
current tier is below `maxTiers`. (Wall-clock / commits / todos caps still
terminate the run immediately when they trip — the ratchet only takes over
when the natural completion path would have fired early.)

**Action.** Instead of writing summary and terminating, call a
`tryPromoteNextTier(planner, priorContract, boardSnapshot)` helper that:
1. Increments `currentTier`.
2. Prompts the planner (with optional Unit-30-style council wrap) with:
   - The prior contract and its per-criterion verdicts (all "met").
   - The current git state / listing of what was committed.
   - A tier-up directive: _"Produce a SINGLE JSON contract for the next
     tier of ambition. Every criterion must EXTEND the prior work, not
     revise or duplicate it. This tier should be materially more
     ambitious than the prior one."_
3. Parses + grounds the new contract via the existing Unit 6b path.
4. Installs the new contract as the active one (reset per-criterion
   statuses to "unmet"; `addedAt` gets a fresh timestamp).
5. The executing loop continues with the new contract; workers drain it;
   auditor eventually verdicts.

**Termination.** The ratchet stops climbing when:
- `currentTier >= maxTiers`, OR
- Any hard cap trips, OR
- User stop, OR
- Three consecutive tier-up prompts fail to parse (bail out to avoid
  infinite failed-ratchet loop), OR
- A tier-up prompt produces 0 valid criteria (planner saw nothing left
  to do even at the next tier).

**Config.** `AMBITION_RATCHET_ENABLED=true` env default-off to start. Per-run
override via `ambitionTiers: number` in the start payload (0 = off,
default when env is off; 1–10 = on, with that cap). Integrates with
Unit 32's per-preset Advanced section.

**State & summary.** Each tier's contract gets `tier: N` stamped on it.
The state snapshot exposes `currentTier` and `tiersCompleted`. The run
summary gains an optional `tierHistory: Array<{tier, criteriaTotal,
criteriaMet, criteriaWontDo, wallClockMs}>` so cross-run comparison can
answer "did tier 3 actually ship more work than tier 1?"

**Guardrails against rubber-stamping.** A tier that completes with
suspiciously low effort (e.g., all criteria met in < 2 min AND fewer
than N commits) flags a `suspicious_tier_completion` finding. Doesn't
block the ratchet, but surfaces in the summary for post-mortem.

## Open questions

- Should tier N+1 be allowed to _narrow_ focus (e.g., pick one criterion
  from tier N and zoom in), or only broaden?
- How does the ratchet interact with Unit 25's user directive? Does the
  directive re-apply at every tier, or only tier 1?
- Should auditor acceptance of "met" get stricter at higher tiers (raise
  the bar for evidence), or stay constant?

These are worth revisiting after Unit 34's first real battle-test shows
what actually breaks.

---

## Unit 37 — Planner + auditor use `swarm-read` profile (spec-lite)

**Motivation.** See `docs/known-limitations.md` entry "Planner has ALL
tools disabled". The 2026-04-23 kyahoofinance032926 smoke made the
problem concrete — tier-1 criteria like "add `.gitignore`" reveal the
planner isn't inspecting actual code. Fix is structural: route the
planner and auditor through the existing `swarm-read` profile (Unit 20
shipped this profile for discussion presets — read/grep/glob/list on,
write/edit/bash off) instead of the `swarm` profile that's meant for
workers.

**Scope:**
- `BlackboardRunner.promptAgent` already takes an `agentName` parameter
  passed to `session.prompt.body.agent`. The planner code-paths
  (`runFirstPassContract`, `tryPromoteNextTier`, `runAuditor`,
  `replanOne`) currently pass (implicitly) `"swarm"`. Change them to
  pass `"swarm-read"`.
- Workers (`runWorker`) STAY on `"swarm"` — they must return JSON
  diffs via the board CAS path, not touch files via tool loop.
- Update the planner / first-pass-contract / tier-up prompts to
  EXPLICITLY instruct tool use:
  - "Before proposing criteria, use `read`, `grep`, `glob`, `list` to
    inspect the actual code. Read `package.json`. Grep for existing
    implementations of what the README claims. List source
    directories you suspect are relevant."
  - "Criteria must reflect the code you actually saw, not the code you
    imagined from the file list."
- Update the auditor system prompt similarly: "When reviewing file
  state, use tools to inspect surrounding files that aren't in
  `expectedFiles` if the verdict is ambiguous from the direct evidence
  alone."

**Trade-off:** tool loops add round-trips. A planner call that was one
30-s prompt might become one 90-s prompt with 4 tool calls. Total wall
clock for tier-1 might grow. Expected benefit: dramatically better
contract quality, which means fewer wasted worker commits.

**Open question:** should the critic (Unit 35) ALSO use `swarm-read`?
Critic currently runs with `"swarm"` and sees only the seed. Giving it
read tools would let it check duplicate patterns across the actual
codebase, not just the recent-commits list in the seed. Probably yes —
but scope-gate to Unit 37b if it bloats this unit.

---

## Unit 38 — Agent-lifecycle control + orphan reclamation (spec-lite)

**Motivation.** See `docs/known-limitations.md` entry "Agent-lifecycle
control is unreliable". Live evidence 2026-04-23: user stop doesn't
reliably transition `phase: executing` → `stopped`; `tasklist` showed
15+ `node.exe` orphans on Kevin's box after a session with ~5 runs.
Every dev-server restart leaves its spawned opencode subprocesses as
orphans because the new `AgentManager` instance has no knowledge of
them.

**Scope:**

1. **PID file per run** — on `AgentManager.spawnAgent`, append the
   subprocess PID (`child.pid`) to `<clonePath>/.agent-pids` (one PID
   per line). On `killAll`, after the kill batch, delete the file.
   Atomic via the existing `writeFileAtomic` helper.

2. **Orphan sweep on server startup** — in `server/src/index.ts`,
   before `server.listen`, scan the `runs/` directory for any
   `.agent-pids` files. For each PID, check if it's alive (`tasklist
   /PID <pid>` on Windows, `kill -0 <pid>` on POSIX). If alive AND it
   looks like an opencode process (check command line), kill it. Then
   clear the PID file.

3. **Verified kill in `killAll`** — after `treeKill`, poll the PID for
   liveness with a ~5 s deadline. If still alive, escalate: `taskkill
   /F /T /PID` with retries, then as a last resort `kill -9` the
   direct child PID. Log every kill decision to the transcript.

4. **Server-side shutdown signal** — on SIGINT/SIGTERM, ensure
   `orchestrator.stop()` runs to completion BEFORE process exit. The
   current pattern (`setTimeout(() => process.exit(1), 5000).unref()`)
   has a 5-s watchdog that may fire before `killAll` finishes on a
   slow stop. Extend to 10 s with a stronger guarantee.

5. **Stop signal reliability** — on `POST /api/swarm/stop`, return
   only AFTER `killAll` has verified every agent is dead. Currently
   the response fires after `setPhase("stopping")` which races the
   actual kills. Await the kill verification chain so the client can
   trust a 200 OK as "really stopped."

**Non-goals:**

- Windows Job Objects integration — would be the BEST fix but needs a
  native addon or FFI. Defer until the above isn't enough.
- Killing random `node.exe` by port-range sweep on startup — nuclear,
  risks killing unrelated dev work. PID-file approach is surgical.

**Dependency:** none. Can ship independently of Unit 37.
