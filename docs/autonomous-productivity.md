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
| 51   | Reload prior contract from blackboard-state | shipped (`91e83cd`, 2026-04-23)|
| 52a  | Runtime ticker (header)                      | shipped (`4fb6921`, 2026-04-23)|
| 52b  | Composite status badge                       | shipped (`ee4284b`, 2026-04-23)|
| 52c  | Run identity strip + click-to-open path      | shipped (`9467c43`, 2026-04-23)|
| 52d  | Identifiers row (click-to-copy chips)        | shipped (`0b15bc3`, 2026-04-23)|
| 52e  | Run history dropdown + digest modal          | shipped (`103da5c`, 2026-04-23)|
| 53   | Contract panel: status filter (default unmet)| shipped (`1c9edfd`, 2026-04-23)|
| 54   | Transcript: collapse worker JSON to summary | shipped (`15a7b81`, 2026-04-23)|
| 55   | Auto-killAll on natural completion          | shipped (`76fe957`, 2026-04-23)|
| 56   | Topbar + sidebar consolidation              | shipped (`92e7d3a`, 2026-04-23)|
| 56b  | Contract: dedupe counts (drop label row)    | shipped (`d65a2e3`, 2026-04-23)|
| 57   | Unit 51 fix: cache snapshot before phase    | shipped (`256f025`, 2026-04-23)|
| 57b  | Unit 39 thinkingSince REST-snapshot fix     | shipped (`256f025`, 2026-04-23)|
| 58   | Dedicated auditor agent (parallel to planner)| planned (Kevin's ask 2026-04-23)|
| 59   | Specialized-worker blackboard variant       | planned (Kevin's ask 2026-04-23)|
| 60   | Multi-prompt critic ensemble                | planned (Kevin's ask 2026-04-23)|
| 62   | Page-refresh persistence (WS catch-up snapshot) | planned (Kevin's ask 2026-04-23)|
| 63   | SetupForm: expose ambitionTiers + multi-hour preset chip | planned (Kevin's ask 2026-04-23)|
| 64+  | Cross-run resume + tier-aware replay        | hypothesized                   |
| 64+  | Auto-start app (workers execute shell)      | hypothesized                   |
| 64+  | Persistent swarm-ui across audits           | hypothesized                   |

(Unit 61 was queued during the 2026-04-23 brainstorm based on Kevin's
"models want conversation" hypothesis. Both Kevin and Claude reviewed
and dropped it — the CoT-before-JSON change has marginal upside on
reasoning-heavy auditor prompts but compounds Unit 46a's audit-timeout
risk we just fixed. Better levers elsewhere.)

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


## Unit 56 — Topbar + sidebar consolidation (spec-lite)

Kevin's 2026-04-23 ask after seeing the Phase A+B+C UI shipped:
"there are multiple topbars... lets put all agent-specific
information [in the left-sidebar agent cards] for concise
presentation, and put all the run-specific information into a
single topbar." Reduces 2 topbars to 1, moves what's naturally
agent-scoped to the agent panel.

**End state (after this unit):**

1. App header (unchanged) — title + RuntimeTicker + PhasePill.
2. CloneBanner (unchanged — Kevin: "this is great. lets keep this").
3. **Single run-identity topbar** with: run uuid (chip,
   click-to-copy), run name, preset, planner model, worker model,
   total agents count, project path (truncate-from-LEFT,
   click-to-open via POST /api/swarm/open).
4. Left sidebar header: "Agents (N)" — count moves here.
5. Left sidebar **agent cards (enhanced)**: agent index, role
   (planner / worker), status, thinking ticker (Unit 39), retry
   indicator (Unit 39), latency sparkline tooltip (Unit 40),
   session id chip (click-to-copy), model name (chip).

**What goes away:** the separate IdentifiersRow (Unit 52d). Its
run-uuid concern moves into the topbar; its per-agent session-id
+ model concerns move into the AgentPanel cards.

**Implementation sketch:**
- Extract a shared `<CopyChip>` component (currently lives inside
  SwarmView).
- AgentPanel takes new props: `role: "planner" | "worker"` and
  `model: string`, derived in SwarmView from `agent.index === 1`
  and `runConfig.{plannerModel|workerModel}`.
- Sidebar `Agents` header → `Agents ({agentList.length})`.
- IdentityStrip absorbs the run-uuid chip, IdentifiersRow component
  + its invocation deleted.

Pure web — no server/type changes. ~45 min. Pairs nicely with the
Unit 39 thinkingSince REST-snapshot bug fix (deferred since this
session) since both touch AgentPanel.

## Unit 56b — Contract panel: drop the duplicate counts row (spec-lite)

Kevin's 2026-04-23 ask: the Contract tab shows "0 met / 8 unmet / 0
wont-do" TWICE — once as a label-only line in the criteria header,
once as the four-button filter row from Unit 53 (each button shows
its own count). Drop the label-only version, keep the buttons (they
encode the same information AND provide the filter affordance).

Trivial — a couple lines deleted from `web/src/components/ContractPanel.tsx`.
~5 min. Bundle with Unit 56 since both touch UI cleanup.

## Unit 58 — Dedicated auditor agent (spec-lite)

Kevin's "I have budget" brainstorm 2026-04-23: the most leveraged
single architectural change. Today agent-1 wears 4 hats (planner /
poster / replanner / auditor / + critic on fresh session). The
auditor pass is the single biggest bottleneck — Unit 46b had to
truncate the audit prompt to 60 KB because it grows with every
committed/skipped todo + every file in unmet criteria's
expectedFiles. Run-3 of seaj-tsia-study spent ~10 min on its first
audit; with workers idle for that whole window.

**The change:** introduce a dedicated auditor agent (separate
opencode session, optionally a different model — auditing is
diff/criteria reasoning, could even use a smaller faster model).
Agent-1 stays planner-only. Audit happens IN PARALLEL with workers
draining the next batch of todos.

**Wins (data-driven):**
- Workers don't idle during audit (run-3 they were idle for 10
  min while the first audit ran — that's 30+ todos worth of
  parallel work foregone).
- Fresh session for the auditor avoids anchoring bias on the
  planner's prior decisions (same Unit 35-fix logic as the
  critic).
- If the auditor hangs/times out (Unit 46a's 600 s ceiling),
  workers keep working — only the audit verdict is delayed,
  not the whole run.

**Risks:**
- Loses the planner's session memory of "why I posted these
  todos." Auditor sees the criteria + file state cold. May
  matter on subtle / context-dependent verdicts.
- Another opencode subprocess + cloud session to manage
  (though Unit 38's PID tracker + Unit 41's verified-kill make
  this cheap).

**Implementation sketch:**
- New AgentManager.spawnAuditor() called once at run-start.
- BlackboardRunner's ~7 audit-call sites switch from
  `promptPlannerWithFallback(planner, ...)` to
  `promptAgent(this.auditor, ...)`.
- killAll already covers the new agent.
- ~2 hours including testing.

**Order matters**: ship Unit 57 (snapshot race fix) BEFORE this
unit so the auditor's prior-state read is reliable.

## Unit 59 — Specialized-worker blackboard variant (spec-lite)

Most research-backed of the three brainstorm items.
**Precedent**: MetaGPT (Hong et al. 2023) PM/Architect/Engineer/QA
roles outperform single-agent on HumanEval + SoftwareDev; ChatDev
(Qian et al. 2023) CEO/CTO/Programmer/Reviewer/Tester pipeline
improves task completion vs flat agent; AutoGen (Wu et al. 2023,
Microsoft Research) conversational specialization framework with
benchmark wins; AgentVerse (Chen et al. 2023) heterogeneous-agent
framework.

**The change:** a new preset (or a blackboard sub-mode) where each
worker has a deliberately-different role prompt. Two design choices:

**59a — Per-worker static role.** Worker-1 = "you bias toward
correctness and edge cases." Worker-2 = "you bias toward simplicity
and minimal diff." Worker-3 = "you bias toward stylistic
consistency with the existing codebase." Worker pool is
heterogeneous; planner doesn't decide which gets what — todos
go to whichever worker is free, and the role bias shapes the
diff.

**59b — Planner-tagged routing.** Planner emits each todo with a
`requiredRole` field (e.g., `"architecture"`, `"tactical-edit"`,
`"test-coverage"`). Each worker has a role at spawn time;
findClaimableTodo (Unit 45) only returns todos whose required
role matches the worker's. Stronger specialization signal,
more coordination cost.

**Recommendation:** 59a first. It piggybacks on Unit 32's role
catalog (already built for the role-diff discussion preset);
porting that machinery into the blackboard worker prompt is a
~3-4 hour unit. 59b is a more invasive Unit 59b that requires
schema changes to Todo + the planner's output shape.

**A/B opportunity:** with the resume-contract path (Unit 51), you
can run the SAME contract through both vanilla blackboard and the
specialized variant and compare commit quality / criteria-met rate.

## Unit 60 — Multi-prompt critic ensemble (spec-lite)

Worth-testing addition from the brainstorm. **Precedent**:
Multi-Agent Debate (Du et al. 2023) and ChatEval (Chan et al. 2023)
show multiple critics beat a single critic on factuality +
human-correlation when the critics have **diverse perspectives**
(not just more votes from the same prompt).

**The change:** Unit 35's single critic at commit time becomes a
3-critic ensemble. Each critic uses a deliberately different
prompt:

- **Substance critic** — "is this real work or busywork?"
  (current Unit 35 prompt, unchanged)
- **Regression critic** — "could this break anything that was
  working before? Look at the file's other consumers."
- **Consistency critic** — "does this match the codebase's
  established patterns / style / naming?"

Verdict is **majority vote**: 2-of-3 must accept. Tie-breaking:
substance critic wins (it's the most directly load-bearing).

**Cost**: triples the per-commit critic-prompt count. Throwing
budget at quality. ~60 min of work; 100% of the cost is per-commit
runtime.

**A/B opportunity**: compare same contract under single-critic
(Unit 35) vs ensemble. Measure: (a) how many commits the ensemble
rejects that Unit 35 would have accepted, (b) how many of those
were actually busywork on manual review.

## Unit 63 — SetupForm: expose ambitionTiers + multi-hour preset chip (spec-lite)

Kevin's 2026-04-23 ask: today's SetupForm has Unit 43's wall-clock
cap input but NOT Unit 34's `ambitionTiers` input. To run the
"multi-hour autonomous improvement" north-star scenario you have
to know to POST it directly. Surface the knob in the UI.

**Two changes:**

**63a — `ambitionTiers` input.** Add to the blackboard
`PresetAdvancedSettings` next to the wall-clock cap. Number input,
0-20 (matches route Zod cap). Empty/0 = inherit env (today's
default off). Helper text: "0 = stop on first 'all met' (default).
1-20 = climb that many tiers — each tier asks the planner for a
more ambitious next contract once the current one is satisfied."

**63b — Multi-hour preset chip.** A one-click "Multi-hour
autonomous (8h, 5 tiers)" button next to the cap inputs that fills
both fields:
- `wallClockCapMin` → 480
- `ambitionTiers` → 5

Mirrors the existing "+ Deliver every README feature + research"
chip pattern under the user-directive textarea. Lets the user opt
into the north-star scenario without needing to remember the magic
numbers.

**Validation/UX nits:**
- When `ambitionTiers > 0` AND `wallClockCapMin < 60`, show a soft
  warning ("tier-climb usually needs >1 hr to make a meaningful
  second tier"). Inline text under the input, not a modal.
- The chip's button label dynamically updates if defaults change
  later (single source-of-truth in a constant).

Pure web — no server / Zod changes. The route schema already
accepts `ambitionTiers` (added in Unit 34). ~30 min total.

## Unit 62 — Page-refresh persistence (WS catch-up snapshot) (spec-lite)

Kevin's 2026-04-23 ask after Ctrl-R cleared the blackboard view.
Today the zustand store is purely client-side and refresh wipes
it. /api/swarm/status returns SOME state (phase, agents,
transcript, summary, contract) but NOT board snapshot, clone state,
run config (preset/models/path), run id, or latency samples —
all the things added by Units 40, 47, 52a, 52c, 52d.

**The change:** make refresh non-destructive by hydrating the
store from a server snapshot on connect.

**Two design options:**

**62a — Extend GET /api/swarm/status.** Add the missing fields
to the response: `board`, `cloneState`, `runConfig`, `runId`,
`latency` (recent samples per agent, capped). Client fetches on
mount and dispatches into store. Simple; one HTTP round-trip on
every page load. Existing WS streams subsequent live events.

**62b — WS catch-up event.** Server emits a synthetic
`catch_up` SwarmEvent on every WS open with the full snapshot.
Client handles it like any other event. No extra HTTP. Cleaner
single channel; WS handler grows.

**Recommendation:** 62a first — smaller diff (no new event
variant; uses existing REST). Future Unit 62b can switch if the
extra HTTP becomes an issue.

**Server work:** extend BlackboardRunner.status() (and the
non-blackboard runners' status() implementations) to include the
missing fields. AgentManager already tracks per-agent latency
samples for Unit 40 — expose them.

**Client work:** useSwarmSocket gets a `useEffect` that fetches
`/api/swarm/status` once on mount, dispatches each piece into the
store via existing setters (`upsertTodo`, `setCloneState`,
`setRunConfig`, etc.). All those setters already exist.

**Edge case:** if no run is active (phase=idle), the catch-up
returns nothing and the SetupForm renders normally — no
regression.

~60 min total.

## Unit 57 — Fix Unit 51 snapshot read race (spec-lite)

Self-flagged 2026-04-23 during the post-Unit-51 validation run.
Symptom: `tryResumeContract` correctly fell back to first-pass-
contract because the on-disk `blackboard-state.json` had no
contract. Cause: the runner's own setPhase("spawning") at the top
of start fires `scheduleStateWrite()` debounced 1s; spawning takes
~3-5s with N opencode subprocess starts, so by the time
planAndExecute calls tryResumeContract the prior run's snapshot
has been overwritten with a fresh phase=spawning + no-contract
shape.

**Fix:** read the snapshot at the very TOP of `runner.start()`,
BEFORE any setPhase fires. Cache as a private field
`this.priorSnapshot?: BlackboardStateSnapshot | null`.
`tryResumeContract` consumes the cached value instead of re-reading
from disk. ~15 min, no schema changes.

