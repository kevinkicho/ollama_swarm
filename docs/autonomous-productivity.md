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
| 45   | Per-file claim lock (anti-thrash)           | shipped (`54f90c5`, 2026-04-23)|
| 46   | HEADERS_TIMEOUT 600s + auditor prompt caps  | shipped (`c74cb7d`, 2026-04-23)|
| 47   | Existing-clone work-pattern: detect + UI cue| shipped (`a512ffd`, 2026-04-23)|
| 48   | Hide runner artifacts via .git/info/exclude | shipped (`fcf29ea`, 2026-04-23)|
| 49   | Per-run summary file naming (no overwrite)  | shipped (`6f9b388`, 2026-04-23)|
| 50   | Planner reads prior summary on resume       | shipped (`bffa885`, 2026-04-23)|
| 51   | Reload prior contract from blackboard-state | planned (Kevin's ask 2026-04-23)|
| 52a  | Runtime ticker (header)                      | shipped (`4fb6921`, 2026-04-23)|
| 52b  | Composite status badge                       | shipped (`ee4284b`, 2026-04-23)|
| 52c  | Run identity strip + click-to-open path      | shipped (`9467c43`, 2026-04-23)|
| 52d  | Identifiers row (click-to-copy chips)        | shipped (`0b15bc3`, 2026-04-23)|
| 52e  | Run history dropdown + digest modal          | shipped (`103da5c`, 2026-04-23)|
| 53   | Contract panel: status filter (default unmet)| shipped (`1c9edfd`, 2026-04-23)|
| 54   | Transcript: collapse worker JSON to summary | shipped (`15a7b81`, 2026-04-23)|
| 55   | Auto-killAll on natural completion          | shipped (`76fe957`, 2026-04-23)|
| 56+  | Cross-run resume + tier-aware replay        | hypothesized                   |
| 56+  | Auto-start app (workers execute shell)      | hypothesized                   |
| 56+  | Persistent swarm-ui across audits           | hypothesized                   |

## Units 47-51 — Build-on-existing-clone work pattern (spec-lite)

Kevin's 2026-04-23 framing: "trying to recreate exact conditions by
copying into a new isolated folder is just going to be waste of credit.
I want us to build upon the project using our app and call that a
test." The seaj-tsia-study run-3 (post-Unit-46) is the first run that
intentionally reuses the prior run's clone — and the architecture
already supports this (RepoService.clone returns alreadyPresent without
re-cloning when the dir is a git repo). These five units harden the
ergonomics so the pattern is first-class, not accidental.

**Unit 47 — Existing-clone detect + UI cue.** When the user POSTs
/start with a `parentPath` that already contains a clone of the same
repo, surface this in the response (e.g. `{ resumed: true,
priorCommits: 4, priorChangedFiles: 5 }`) AND in the SetupForm UI
(blue badge: "Resuming work on existing clone — 4 prior commits, 5
modified files"). Currently the run silently reuses; users could be
confused if they expected a fresh start. ~30 min.

**Unit 48 — Gitignore runner artifacts in clone.** The runner writes
`opencode.json`, `blackboard-state.json`, and `summary.json` into the
clone root as untracked files. They pollute `git status` and a
human-curating-the-repo flow. Either (a) add them to a `.gitignore`
the runner appends to on first run, (b) write them outside the clone
(e.g. `<parentPath>/.swarm-meta/<run-name>/`), or (c) accept the
pollution as intentional (visible audit trail). Pick before we ship —
the cleanest is probably (b). ~45 min.

**Unit 49 — Per-run summary file naming.** Today every run writes
`summary.json` at the clone root, so a 2nd run silently overwrites the
1st run's summary — the comparison file we just wrote (run #2 vs v6)
would have been impossible without my mid-session manual `mv`. Fix:
write to `summary-<runStartedAt>.json` (or `summary-<isoDate>.json`)
AND symlink/copy to `summary.json` for the "latest" pointer. ~20 min.

**Unit 50 — Planner reads prior summary on resume.** When the
`alreadyPresent` flag is true and a `summary*.json` exists, include the
prior summary's contract + verdicts + skipped reasons in the planner's
seed (capped, like Unit 46b's auditor caps). The planner can then
build new criteria that DON'T re-attempt what the prior run already
classified as wont-do or already-met, and can pick up unmet criteria
from where the prior run left off. ~60 min.

**Unit 51 — Reload prior contract from blackboard-state.json.** The
runner currently writes `blackboard-state.json` but never reads it —
it has full prior contract + tier history. On resume, optionally
re-hydrate the contract instead of re-deriving from scratch. Avoids
the planner non-determinism (run #2's contract framing differed from
run #1 because the planner re-derived). Pair with Unit 50 for full
"continue where we left off" semantics. ~90 min, more invasive
because tier-history hydration touches the ratchet machinery.

## Unit 52 — Run-identity panel + run history dropdown (spec-lite)

Kevin's 2026-04-23 framing during seaj-tsia-study run-3: the top
right corner shows just `executing` with no run-level context, so
mid-run it's hard to tell which run is which when reviewing logs
or comparing across attempts. This unit is the run-level
observability surface in the UI. Each sub-bullet is independently
shippable; bundle them or split into 52a/52b/52c as needed.

**52a — Total runtime ticker.** Wall-clock since `startedAt` (from
the run config), shown in the status bar near the phase badge.
Tick at 1s. When the run ends, freeze at final wallClockMs.
Non-trivial only because `startedAt` isn't currently broadcast as
a SwarmEvent — needs either a one-shot run-start event with the
config, or extending swarm_state to carry it. ~30 min.

**52b — Meaningful run status badge.** Today the top-right just
shows the SwarmPhase enum verbatim (`executing`). Replace with a
composite signal: `executing — round 3 — 21 commits / 30 todos`
(or similar). When `phase=stopping`, show what we're waiting on
(active aborts, killAll progress). When `phase=executing` and
all agents have been thinking >5 min, show `slow-audit` with a
tooltip. ~45 min.

**52c — Run identity strip.** Persistent strip showing: run name
(derived from clone-dir basename or user-provided), preset
(blackboard / round-robin / etc.), planner model + worker model
(Unit 42), project directory (truncate-from-LEFT so the
distinguishing-tail is visible: `…ollama_swarm\runs\post-unit41-baseline\seaj-tsia-study`),
click → opens OS file manager (Windows Explorer / macOS Finder /
xdg-open). On the backend side, run-name might be inferred from
parentPath if not explicitly named. ~60 min.

**52d — Identifiers row.** Compact row with: app run id (a
new uuid we mint at start, today nothing exists), opencode session
ids per agent (already in `AgentState.sessionId`), Ollama model
slugs (`glm-5.1:cloud`, `gemma4:31b-cloud`). Each click-to-copy.
The opencode session id specifically is what you'd grep
`logs/current.jsonl` for to debug a single agent's prompts.
~30 min.

**52e — Run history dropdown.** Reads `runs/*/summary.json`
via a new `/api/runs` endpoint, sorted by mtime descending.
Selecting a prior run swaps the UI into a read-only "viewing
historical run X" mode (events not live; pulled from the persisted
event log + summary). Lets you compare what changed between run-2
and run-3 without flipping between log files. Depends on Unit 49
(per-run summary file naming) so the discovery loop has stable
paths to read. ~90 min.

## Unit 53 — Contract panel: status filter (spec-lite)

Kevin's 2026-04-23 ask during seaj-tsia-study run-3: by the time the
auditor has resolved 5+ criteria, the Contract tab is dominated by
already-`met` rows that the user no longer cares about. Add a
3-button filter row above the criteria list: **All / Unmet / Met**
(maybe also `Wont-do` as a 4th). Default selection is **Unmet** so
the panel always opens onto the criteria still in flight. Filter
state can live in zustand (transient) or persist to localStorage
keyed by run name (preferred — survives reloads mid-run).
~30 min. Pure web/, no server changes.

## Unit 54 — Transcript: collapse worker JSON to summary (spec-lite)

Kevin's 2026-04-23 ask during seaj-tsia-study run-3: workers post
raw JSON hunk responses (often 2000-3000 chars with whole-file
content embedded in `search`/`replace`/`content`). Currently the
transcript renders the first ~300 chars with a "Show more (2912
chars)" expand link. The header is also a generic "Agent 2 ·
5:05:54 PM ```json" — no signal about WHAT the worker is proposing.

Replace the default rendering with a one-line summary derived from
parsing the JSON envelope:
- Success: `Agent 2 · 17:05:54 → 1 replace hunk in assets/js/companies-timeseries.js (2912 chars)`
- Skip: `Agent 2 · 17:05:54 → skip: <reason>`
- Multi-hunk: `Agent 2 · 17:05:54 → 3 hunks (2 replace, 1 append) in 02_KEY_FINANCIALS.md`
- Unparseable: fall back to current truncated-with-Show-more view
  so we don't hide a parser bug behind cleaner UI.

Click the row to expand into the full JSON pretty-printed (or the
file diff if we want to render it as a diff). Skip rows stay
collapsed-by-default since the reason is already visible.

The parser already exists (server-side `parseWorkerResponse`); for
the UI we need a client-side equivalent or a server-emitted
metadata sidecar in the `transcript_append` event (e.g. add an
optional `summary?: { kind, file, hunks, ...}` field). Server-emit
is cleaner — keeps the parsing logic in one place. ~60 min total
(40 server, 20 web). Pairs nicely with Unit 53 since both target
the same "I have too much info, show me less by default" need.

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
