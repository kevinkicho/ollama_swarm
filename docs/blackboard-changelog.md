# Blackboard Swarm — Phase Changelog

Running log of what landed in each phase of the blackboard-preset build and
how it was verified. Companion to [`blackboard-plan.md`](./blackboard-plan.md)
(the *what we plan to do*); this file is the *what we actually did*.

Phases are kept here even after they ship, so later debugging can trace which
phase introduced a particular file or behavior without digging through git.

Legend: **[committed]** = landed on the branch; **[working tree]** = applied
locally, not yet committed; **[pending]** = in plan, not started.

---

## Phase 0 — Preset dispatch layer  **[committed: `0ffa45c`]**

Round-robin extracted unchanged behind a `SwarmRunner` interface so a second
preset can plug in symmetrically.

- Added `server/src/swarm/SwarmRunner.ts` — `{ start(cfg), stop(), status(), injectUser(text) }`.
- Added `server/src/swarm/RoundRobinRunner.ts` — the prior Orchestrator logic verbatim.
- `server/src/services/Orchestrator.ts` became a dispatcher that selects a runner by `cfg.preset`.
- `server/src/routes/swarm.ts` accepts `preset: z.enum([...]).default("round-robin")`. Unknown preset → 400; `"blackboard"` returned 501 until Phase 3.

**Verified:** round-robin transcript byte-identical before/after on `is-odd`.

---

## Phase 1 — Board data model  **[committed: `15ee697`]**

Pure, unit-testable blackboard store. No agents, no WS, no routes.

- `server/src/swarm/blackboard/types.ts` — `Todo`, `Claim`, `Finding`.
- `server/src/swarm/blackboard/Board.ts` — `postTodo`, `claimTodo` (atomic check-and-set), `commitTodo` (CAS against claim-time hashes), `markStale`, `reclaim`, `expireClaims(now)`, `postFinding`, `snapshot`.
- `server/src/swarm/blackboard/Board.test.ts` — 23 tests including claim-race, CAS mismatch, wrong-agent commit, expiry.
- All Board methods synchronous — JS's single-threaded event loop is the mutex. Timestamps/IDs injectable for determinism.

**Verified:** 23/23 tests green; concurrent `claimTodo` race has exactly one winner; commit with mutated hash returns `{ok: false, reason: "stale"}`.

---

## Phase 2 — Board events over WebSocket  **[committed: `1fc6f71`]**

Typed board events reach the browser; UI doesn't render them yet (Phase 8).

- `SwarmEvent` gained 8 `board_*` variants + `BoardCountsDTO` (server/web types kept in sync).
- `server/src/swarm/blackboard/boardBroadcaster.ts` — translates internal `BoardEvent` → `SwarmEvent` and throttles `board_state` snapshots via a 500 ms trailing-edge timer.
- `POST /api/dev/board-poke` — walks a throwaway Board through every event type. Temporary; kept alive through Phase 5 for end-to-end WS debugging, to be removed when the UI board view ships.

**Verified:** browser WS inspector sees each event type once per poke; rapid pokes still emit ≤ 2 `board_state` events/sec.

---

## Phase 3 — Planner agent role (read-only)  **[committed: `72fd230`]**

One agent turns a repo tour into a JSON array of atomic TODOs, posts them to the board. No workers, no writes.

- `server/src/swarm/blackboard/prompts/planner.ts` — zod-validated schema (≤2 files, ≤500-char description, ≤20 todos); tolerant to ```json``` fences and surrounding prose; top-level-object inputs rejected rather than silently unwrapped.
- `server/src/swarm/blackboard/prompts/planner.test.ts` — happy paths, rejections, drop-invalid-items behavior.
- `server/src/swarm/blackboard/BlackboardRunner.ts` — skeleton runner: clone → spawn planner → seed (tree + README excerpt) → prompt → parse → `board.postTodo`. Reuses the idle-watchdog + absolute-cap pattern from round-robin for the planner prompt.
- `Orchestrator`: assigns `this.runner` **before** awaiting `runner.start()` so a mid-run WS client sees the real phase, not idle. On failure, clears the reference so the next start isn't false-positived as "already running."
- `scripts/poke-blackboard.ps1`, `scripts/stop-swarm.ps1` — verification helpers that sidestep PowerShell here-string paste gotchas.

**Verified:** planner posted 6–9 valid TODOs on `is-odd` within ~45 s; broken repo (empty clone) produces zero TODOs + a finding; repair-prompt fires exactly once on forced non-JSON output.

---

## Phase 4 — Worker claim + execute (dry-run)  **[committed: `1a66fb0`]**

Workers spawn, claim todos, produce JSON diffs, log "would commit" — **no real file writes**. The prompt-engineering phase.

- `server/src/swarm/blackboard/prompts/worker.ts` — zod schema for `{diffs: [{file, newText}]}`. Enforces:
  - each `diff.file` is in `expectedFiles` (this is what made Phase 5 Step B a no-op),
  - no duplicate files in a batch,
  - ≤ 2 diffs per response,
  - non-blank file paths.
- `server/src/swarm/blackboard/prompts/worker.test.ts` — 13 tests (happy paths + every rejection path).
- `BlackboardRunner` expanded:
  - Spawns `agentCount - 1` workers alongside the planner.
  - Per-agent loop: poll board every 2 s with jitter, claim, read+hash expectedFiles, prompt worker, parse diff, **log** "would commit", `board.commitTodo` with unchanged hashes.
  - Per-worker cooldown ~5 s after commit.
  - Claim TTL 10 min; `expireClaims` runs every 30 s.
- `scripts/poke-blackboard.ps1` terminal-phase set extended to include `"failed"`.
- `RoundRobinRunner.ts` — received parallel edits to match a `BlackboardRunner` refinement: removed a 120 s idle-silence cap that was firing spuriously on `glm-5.1:cloud` long turns; both runners now pass `agent: "swarm"` on `session.prompt` so the OpenCode-side agent config is applied.

**Verified:** dry-run on `is-odd` with 3 agents posts todos, workers drain the board, **no source files touched** — confirmed by `git status` clean inside the clone. Claim-race test: 4 workers on 1 todo, only one commits.

---

## Phase 5 — Real writes with optimistic CAS  **[committed: `1e7a357`]**

Workers actually modify files. Every commit is re-hashed against claim-time
hashes and refused if anything drifted. Broken down into five independently
revertable steps for safety.

### Step A — Core re-hash + atomic write

- `server/src/swarm/blackboard/writeFileAtomic.ts` — tmp-file + `fsync` + `rename` helper. Creates missing parents. Unique tmp suffix (`pid-time-random`) so concurrent writes in the same dir don't collide. Leftover tmp is cleaned on rename failure.
- `server/src/swarm/blackboard/writeFileAtomic.test.ts` — 4 tests: create, overwrite-no-leftover, missing-parent-dir, utf-8 passthrough.
- `BlackboardRunner.executeWorkerTodo` now:
  1. Re-hashes every file in `expectedFiles` after the claim (before the write).
  2. On any mismatch → `board.markStale(..., "CAS mismatch before write: ...")`, returns `stale`.
  3. Otherwise writes each diff via `writeFileAtomic`. On write failure mid-batch: `markStale("write failed: ...")` + system log + error event. Partial writes are left on disk — Phase 6 replan will pick up whatever state resulted.
  4. Then `board.commitTodo` — trivially passes since nothing else touched the files between our re-hash and our write in the same event-loop tick.
- Header comment updated; removed Phase 4 "dry-run" language.

**Verified end-to-end on `is-odd`:** 9 real commits landed, `git diff` showed the expected changes. One organic CAS mismatch caught on `package.json` (two todos overlapped it); the losing worker's todo was marked stale as designed. One undici `UND_ERR_HEADERS_TIMEOUT` mid-prompt handled cleanly via the stale path. Zero `.swarm-tmp-*` leftovers.

### Step B — expectedFiles whitelist  **[no-op; already enforced]**

Audit revealed `prompts/worker.ts:81–91` already rejects any diff whose `file` is not in the todo's `expectedFiles` (the check was added in Phase 4). Choosing the single-enforcement-point design (at parse time) over belt-and-suspenders — a second runner-side check would be redundant and could mask a parser regression.

No code change; documented here so future readers don't wonder where the runtime guard is.

### Step C — Empty-newText guard (block zeroing non-empty files)

- `server/src/swarm/blackboard/diffValidation.ts` — new module with `findZeroedFiles(diffs, oldContents)`. Returns the subset of diffs whose `newText` is empty *and* whose previous content was non-empty. Deliberately creating new empty files (old absent or old empty) stays allowed.
- `server/src/swarm/blackboard/diffValidation.test.ts` — 6 tests covering all 4 old/new empty/non-empty combinations + multi-diff batches + order preservation.
- `BlackboardRunner.executeWorkerTodo` wires the check between CAS and writes. On any offender → `markStale("worker would zero non-empty file(s): ...")`, `return "stale"`.

**Why at the runner, not at parse time:** the check needs the *old* file contents, which only the runner has. Parser runs before we read the files.

### Step D — UTF-8 BOM guard

- `diffValidation.ts` extended with `findBomPrefixed(diffs)` — returns files whose `newText.charCodeAt(0) === 0xFEFF`. A leading BOM silently breaks everything: git treats the file as unchanged, Node parsers throw, linters report phantom errors. Interior BOMs are legal codepoints and left alone.
- `diffValidation.test.ts` extended with 4 BOM tests: no-BOM, leading-BOM, mid-string-BOM (must be ignored), mixed batch.
- `BlackboardRunner.executeWorkerTodo` wires the check right after the zeroing guard, before the writes. On any offender → `markStale("worker output has leading UTF-8 BOM in: ...")`, `return "stale"`.

### Step E — Symlink-safe `resolveSafe`

- `server/src/swarm/blackboard/resolveSafe.ts` — extracted the path-safety logic out of `BlackboardRunner` into a pure async helper `resolveSafe(clone, relPath)`:
  1. Lexical guards (absolute path, `..`, `.git`) — cheap, no fs.
  2. Walk up the ancestor chain with `fs.lstat` to the first existing component (handles targets that don't exist yet — new files).
  3. `fs.realpath` that ancestor, re-append the non-existent tail.
  4. Re-check clone-relative and `.git` on the resolved path.
  5. Dangling symlinks along the chain are rejected explicitly ("path escapes clone via dangling symlink").
- `server/src/swarm/blackboard/resolveSafe.test.ts` — 11 tests (7 lexical + 4 symlink). The symlink tests use a `trySymlink` helper that self-skips on EPERM/ENOSYS so the suite still passes on Windows hosts without symlink privileges (junctions work without admin; file symlinks need dev mode).
- `BlackboardRunner.resolveSafe` is now an async wrapper that feeds `this.active.localPath` into the helper. The three call sites (`hashFile`, `writeDiff`, `readExpectedFiles`) gained an `await`. The now-unused `node:path` import was removed.
- `server/package.json` test script includes `resolveSafe.test.ts`.

**Why we re-check `.git` after realpath:** a symlink named `foo` pointing at `.git` would pass the lexical `.git` check but still land the write inside `.git` — we catch that via the post-realpath parts check.

**Phase 5 post-condition (full suite):** `npm test` → 73/73 green; `tsc` clean.

**Phase 5 end-to-end re-validation (2026-04-21, after Step E):** 3 agents × 9 todos on `kevinkicho/multi-agent-orchestrator`, 13.5 min wall-clock → phase `completed`. Counts: 6 committed, 3 stale, 0 skipped. Real files landed: `CONTRIBUTING.md`, `.github/workflows/ci.yml`, `scripts/setup.ts`, `src/server.ts`, plus patches to `.env.example` (+17) and `src/index.ts` (+99). Zero `.swarm-tmp-*` leftovers. Two of the three stales were *correct worker self-declines* on already-satisfied todos (`.gitignore` already compliant; README already had the ASCII diagram) using the schema's `{diffs: []}` skip path — the Step C empty-newText guard was not needed because the schema-level skip fired first. Third stale was an undici headers-timeout on the LICENSE prompt, same environmental class we saw during Step A validation.

---

## Phase 6 — Re-planning loop  **[committed: `6aa06d1`]**

When a todo goes stale, the planner agent — not a dedicated replanner — is
prompted with the stale reason + current file contents and must either
**revise** the todo (new description + expected files) or **skip** it. See
[`known-limitations.md`](./known-limitations.md) §"Planner does double duty as
the replanner" for why one agent covers both roles.

### Step A — Replanner prompt + parser

- `server/src/swarm/blackboard/prompts/replanner.ts` — zod-validated union
  `{revised: {description, expectedFiles}} | {skip: true, reason}`. Same
  strict-JSON-first-then-fence-strip-then-prose-slice extraction as
  planner/worker; rejects top-level arrays and mixed-intent shapes.
- `REPLANNER_SYSTEM_PROMPT` is distinct from the planner's: single-object
  output, explicit shrink-scope-don't-widen rule, skip-criteria listed
  explicitly (already-satisfied, no-longer-applies, would-fail-the-same-way).
- `server/src/swarm/blackboard/prompts/replanner.test.ts` — 15 tests covering
  happy paths (revised, skip, 2-file revised, fences, prose) and rejections
  (malformed JSON, top-level array, missing intent, blank reason, `skip: false`
  literal check, oversize `expectedFiles`).

### Step B — Board replan API  **[no-op; already present]**

`Board.replan(todoId, {description, expectedFiles})` already existed from
Phase 1 — it flips `stale → open`, bumps `replanCount`, clears `staleReason`,
emits `todo_replanned`. Extended `Board.test.ts` with four more cases:
`not_found`, successive-replan count bump (1 → 2), empty-description throw,
and full `todo_replanned` event payload shape. 92/92 tests green.

### Step C — Runner wiring

- `BlackboardRunner` hooks a tee onto `Board`'s emit so every board mutation
  still flows to the broadcaster but also calls a private `onBoardEvent`.
  `todo_stale` events enqueue the todo id for replan.
- `processReplanQueue` serializes through the planner agent (single session,
  so parallel replans would interleave prompts on the same transcript).
- `replanOne`:
  1. Skips if todo is not found or no longer stale (dedup).
  2. Auto-skips if `replanCount ≥ MAX_REPLAN_ATTEMPTS` (3) — `board.skip`
     with reason `"replan attempts exhausted"`.
  3. Re-reads current file contents (the whole reason we replan — the repo
     moved).
  4. Prompts the planner with `REPLANNER_SYSTEM_PROMPT` + seed; one repair
     prompt on parse failure, then `board.skip` on double-failure.
  5. Dispatches `"revised"` → `board.replan`, `"skip"` → `board.skip`.
  6. Any prompt error → `board.skip` with the error message (so we don't
     churn forever on a dead planner).
- Fallback tick at `REPLAN_FALLBACK_TICK_MS` (20 s): sweeps the board for any
  stale missed by the event path (e.g. if `replanOne` itself threw) and
  enqueues it; also force-skips any stale whose `replanCount` reached the cap
  but that somehow didn't get skipped already (keeps workers from looping
  forever on `counts.stale > 0`).
- Worker loop exit condition changed from `open==0 && claimed==0` to
  `open==0 && claimed==0 && stale==0` — Phase 4 treated stales as terminal,
  Phase 6 doesn't (a stale may be resurrected by replan).
- `start()`'s `planAndExecute` captures `this.planner = planner` and calls
  `startReplanWatcher()` once we enter `executing`. `stop()` and the `finally`
  block both call `stopReplanWatcher()` which clears the queue, drops the
  planner reference, and cancels the tick timer.

**Verified (unit):** 92/92 tests green; `tsc --noEmit` clean. End-to-end
verification is Step D.

### Step D — End-to-end smoke test  **[surfaced shutdown-race bug — see Step D-fix]**

Ran `poke-blackboard.ps1 -AgentCount 3` against
`https://github.com/awslabs/multi-agent-orchestrator` (clone path
`mao-bb-phase6`). Outcome:

- 18 todos posted by planner.
- **14 committed** via normal worker flow.
- **3 skipped** via replanner decision (`replanner decided to skip: ...`) —
  the replanner correctly declined already-satisfied / no-longer-applies
  todos. Confirms the skip path end-to-end.
- **2 revised** via replanner (`todo_replanned` event fired, revised
  description + expected files posted back to board). Confirms the revise
  path end-to-end.
- **5 stales** handled in total (3 → skip, 2 → revise). Mix of undici
  `UND_ERR_HEADERS_TIMEOUT` (environmental flake) and CAS-stale from
  concurrent workers.

**Bug surfaced: shutdown race on slow replan.** Todo `20c25ebf` went stale
at t=0 from an undici timeout. Workers polled for `MAX_WORKER_ITERATIONS = 50`
(≈100 s at 2 s/iter + jitter) and exited at t=99 s; swarm phase transitioned
to `completed`. Replanner only finished its REVISE decision at t=117 s — 18 s
after the swarm had already terminated. The revised todo was posted back to
the board at `open` status, but no worker was alive to claim it, so it sits
stranded forever. Docs noted the iteration cap as a "safety valve" from
Phase 4 (predating the replanner), which is exactly the stale assumption the
race exploits.

### Step D-fix — Shutdown-race fix

Goal: workers must not exit while replan work is still in flight, because a
pending replan can resurrect a stale todo back to `open`.

- Removed the `MAX_WORKER_ITERATIONS = 50` constant and the iteration counter
  in `runWorker`. The per-prompt `ABSOLUTE_MAX_MS = 20 min` cap (already
  present) plus the replan-attempts cap (`MAX_REPLAN_ATTEMPTS = 3`) together
  bound total wall-clock, so the iteration counter was redundant and
  actively harmful.
- Extended the worker-exit condition from
  `counts.open === 0 && counts.claimed === 0 && counts.stale === 0` to also
  require `this.replanPending.size === 0 && !this.replanRunning`. A stale
  can still be in the replan queue (waiting for the planner's turn) or
  actively being prompted at the moment the last worker evaluates its exit
  — workers now wait those out.
- `processReplanQueue`'s catch block used to log-and-continue, relying on
  the fallback tick to re-enqueue. That combined with the new exit condition
  would pin workers forever on a repeatedly-crashing replan. Catch now also
  calls `board.skip(todoId, "replanner crashed: ...")` so a terminal failure
  exits in-flight state cleanly. `board.skip` call is itself wrapped in
  try/catch because the todo could have moved state meanwhile.

**Verified (unit):** 92/92 tests green; `tsc --noEmit` clean.

**Verified (E2E):** re-ran `poke-blackboard.ps1 -AgentCount 3` against
`multi-agent-orchestrator` in clone path `mao-bb-phase6-v2`. 17.2 min
wall-clock. Final counts: **15 posted, 13 committed, 2 skipped, 4 stales
handled, 2 replans** (both REVISE). The race-bait case specifically closed:
todo `8eb9c26f` went stale at t≈118 s (CAS mismatch), was revised at
t≈122 s, and committed at t≈252 s — well past the t≈100 s mark where the
old `MAX_WORKER_ITERATIONS = 50` cap would have exited workers and stranded
the revised todo. All other exit paths also exercised: stale → skip
(already-satisfied); stale → revise → stale → skip-after-2nd-attempt.

**Known limitation, carried forward:** the transcript UI renders
worker/planner/replanner JSON responses as raw blobs (e.g. `{"diffs":[…]}`).
Polish task tracked separately — render as one-line summary with a "View
JSON" toggle.

## Phase 7 — Stop conditions + safety valves  **[committed: `d2dcc85`, `0e9a990`, `c7e6934`]**

Hard-cap a run so it always terminates, and capture final state on crash. See
`blackboard-plan.md` §Phase 7 for the step breakdown.

### Step A — Hard caps

Pure decision function + minimal runner wiring so a pathological run can't
run forever. Caps are intentionally generous — normal runs complete well
under them; the caps are a safety valve, not a production tuning knob. Not
runtime-configurable (see `known-limitations.md`); deferred to a later cap
iteration if a real run ever bumps into the defaults.

- `server/src/swarm/blackboard/caps.ts` — `checkCaps({startedAt, now,
  committed, totalTodos}) → string | null`. Constants: `WALL_CLOCK_CAP_MS =
  20 min`, `COMMITS_CAP = 20`, `TODOS_CAP = 30`. Priority when multiple trip
  in the same tick: wall-clock → commits → todos (first-match wins so the
  caller gets one stable reason string).
- `server/src/swarm/blackboard/caps.test.ts` — 10 tests: below-cap null,
  boundary-minus-one passes, each cap fires at its own boundary, priority
  ordering (wall-clock > commits > todos, commits > todos), clock skew
  (`now < startedAt` returns null, not fires negative-past-cap), `>=` vs `>`
  contract (one run that writes exactly COMMITS_CAP terminates immediately
  afterward).
- `BlackboardRunner.ts` — two new state fields (`runStartedAt`,
  `terminationReason`), both reset in `start()`. `runStartedAt` stamped just
  before `setPhase("executing")` so planning time does NOT count toward the
  wall-clock cap (planning is one prompt; caps are a worker-loop guard).
  `checkAndApplyCaps()` helper called at the top of every `runWorker`
  iteration, before the natural-exit check: if a cap trips it logs
  `Stopping: <reason>`, sets `stopping=true` to unblock all workers, and
  aborts every in-flight `activeAborts` controller so a worker mid-prompt
  doesn't sit for the full ABSOLUTE_MAX_MS watchdog. Idempotent — peer
  workers checking simultaneously see `stopping` already set and short-
  circuit.
- `planAndExecute`'s finally-block phase transition changed from
  `if (this.stopping) return` to `if (this.stopping && !this.terminationReason) return`
  so a cap-induced stop still transitions to `completed` (with the reason
  in the transcript), while a user-initiated stop continues to let `stop()`
  drive the phase to `stopped`.

**Verified (unit):** 102/102 tests green (92 prior + 10 new caps tests);
`tsc --noEmit` clean. E2E verification deferred to Step C.

### Step B — Crash snapshot

On uncaught exception in `planAndExecute`, write
`<clone>/board-final.json` with enough state to post-mortem the run. The
`failed` phase transition is unchanged — it was already driven by the
existing `errored` flag — Step B just guarantees there's an artifact on
disk when the UI/WS flips to `failed`.

- `server/src/swarm/blackboard/crashSnapshot.ts` — `buildCrashSnapshot(input)`
  pure shape-assembly function + `CRASH_SNAPSHOT_TRANSCRIPT_MAX = 200` cap
  so a pathological run can't produce a 50 MB snapshot. Tail-slices the
  transcript when over the cap and flags `transcriptTruncated: true` so
  readers know they have the tail, not the whole run.
- `crashSnapshot.test.ts` — 13 tests: Error vs non-Error message/stack
  handling, null/undefined error coercion, config passthrough and
  null-fallback, transcript passthrough below the cap, no-op at exactly
  the cap, tail truncation over the cap with the flag set, board
  passthrough, JSON-roundtrip sanity check.
- `BlackboardRunner.ts` — new `writeCrashSnapshot(err)` method called from
  the existing catch block, awaited before the finally block flips phase
  to `failed` so a WS consumer watching for the transition can trust the
  artifact is already on disk. Uses `writeFileAtomic` so a crash *during*
  the snapshot write doesn't leave a half-written JSON. Swallows its own
  write errors — losing the snapshot is better than turning a normal
  failure into a recursive crash. Logs success/failure to the transcript.

Snapshot shape (top-level keys): `error { message, stack? }`, `phase`,
`runStartedAt`, `crashedAt`, `config` (full RunConfig or null), `board`
(`{todos, findings}`), `transcript` (tail-truncated), `transcriptTruncated`.

**Verified (unit):** 115/115 tests green (102 prior + 13 crashSnapshot);
`tsc --noEmit` clean. Runtime crash-path verification is Step C.

### Step C — E2E verification

Three scenarios run against the live dev server
(`multi-agent-orchestrator` clone, glm-5.1:cloud), verifying the
Phase 7 changes behave correctly end-to-end. No code shipped in this
step — just documentation of what was exercised.

**Scenario 1: Stop mid-claim.** Started a run, polled until executing
phase with pending claims (5 commits landed, 10 todos outstanding),
POSTed `/api/swarm/stop`. Verified: phase transitioned
stopping → stopped → (dispatcher dropped runner → idle); no
`board-final.json` written at clone root (user stop is not a crash).
Pre-existing observation — not a Phase 7 regression: spawned opencode
processes on Windows orphan after `child.kill()` because
`spawn(..., { shell: true })` kills the shell wrapper but not the
opencode.exe it wraps. Tracked separately.

**Scenario 2: Cap fires.** Temporarily set `COMMITS_CAP = 3` in
`caps.ts`, ran against the same repo, reverted after. Observed
transition: planning → executing → `completed` with final transcript
entry `"Stopping: commits cap reached (3)"`. Wall-clock from executing
start to cap-trip ≈ 30 s. Final commit count was 4 (one worker was
mid-prompt when `checkAndApplyCaps` on a peer worker tripped the
cap — acceptable under `>=` semantics, the cap is a soft guardrail).
Verified: phase → `completed` not `stopped` (finally-block's
`terminationReason` discriminator working); no `board-final.json`
(cap is not a crash).

**Scenario 3: Crash snapshot lands.** Temporarily injected
`throw new Error("[Step C CRASH TEST] forced crash after first commit")`
into `runWorker`'s main loop guarded by `committed >= 1`, reverted
after. Observed transition: planning → executing → first commit
(LICENSE) → next worker iteration throws → caught in
`planAndExecute` → `Run failed: ...` system entry → `writeCrashSnapshot`
awaited → `Wrote crash snapshot to <clone>/board-final.json` system
entry → phase → `failed`. Verified `<clone>/board-final.json` top-level
keys (all 8 present): `error{message,stack}`, `phase="executing"`,
`runStartedAt`, `crashedAt`, `config` (full RunConfig with
`preset=blackboard`), `board` (14 planner todos + 0 findings),
`transcript` (9 entries), `transcriptTruncated=false`. Snapshot wall-
clock span: 22 s from `runStartedAt` to `crashedAt`.

**Phase 7 complete.** All three sub-steps verified working in a live
run. Reverts confirmed: working tree clean against HEAD, 115/115 unit
tests still green, `tsc --noEmit` clean.

## Phase 8 — UI board view  **[committed: `76ac564`]**

The Board tab lives alongside Transcript in `SwarmView`. Five columns
(Open, Claimed, Committed, Stale, Skipped) are driven by a pure
grouping over the store's `todos` map; cards sort by `createdAt` within
each column. A collapsible Findings pane sits below the columns.

**Store.** `web/src/state/store.ts` grew `todos: Record<string, Todo>`
and `findings: Finding[]`, plus granular reducers for each board event
(`upsertTodo`, `applyClaim`, `markCommitted`, `markStale`,
`markSkipped`, `applyReplan`, `appendFinding`) and a bulk
`replaceBoard` for `board_state` snapshots. The committed reducer
stamps a UI-side `committedAt = Date.now()` that the next snapshot
overwrites with the authoritative server time.

**Dispatcher.** `useSwarmSocket.ts` now handles the full board event
surface — `board_todo_posted`/`claimed`/`committed`/`stale`/`skipped`/
`replanned`, `board_finding_posted`, and `board_state`.

**Cards.** `TodoCard` is `React.memo`'d and keyed by `todoId + ":" +
status` so a column move doesn't thrash siblings. Each card shows
description, expectedFiles, creator, and per-status extras: claimer +
claim age for Claimed, commit time for Committed, stale reason for
Stale, skip reason for Skipped. A `R<n>` badge appears when
`replanCount > 0`.

**Verified (live).** Ran `blackboard` on
`sindresorhus/is-plain-obj` (3 agents, glm-5.1:cloud). Planner posted
9 todos; 7 committed, 2 skipped. The Board tab rendered all five
columns with correct counts; no console errors; type-check
(`tsc -b` in `web/`) clean.

## Phase 9 — Metrics + run artifact  **[committed: `c342080`]**

Every run leaves `<clone>/summary.json` and broadcasts a matching
`run_summary` WS event so the Board tab shows a summary card without
re-reading disk.

**Pure builder.** `server/src/swarm/blackboard/summary.ts` classifies
`stopReason` from `{crashMessage, terminationReason, stopping}` with a
first-match priority: crash → cap:* → user → completed. Unknown cap
strings fall back to `cap:wall-clock` (least wrong) so a future cap
addition doesn't crash the builder. `finalGitStatus` is truncated at
`FINAL_GIT_STATUS_MAX = 4_000` chars with a `finalGitStatusTruncated`
flag — a pathological git state can't blow out the artifact.

**Runner wiring.** `BlackboardRunner` grew three counters:
`runBootedAt` (stamped in `start()`, spans the whole run including
clone/spawn/plan, distinct from `runStartedAt` which scopes caps),
`staleEventCount` (incremented on every `todo_stale` in `onBoardEvent`,
so replans don't hide thrash), and `turnsPerAgent` (incremented at the
top of `promptAgent`). A frozen `agentRoster` is captured at spawn
time so the per-agent stats survive `AgentManager.killAll()` clearing
its own map during user-stop.

**Write + broadcast.** `writeRunSummary(crashMessage?)` runs from the
`planAndExecute` finally block — covers completed, stopped (user),
cap-stopped, and crashed paths. Writes via `writeFileAtomic`, then
emits `{ type: "run_summary", summary }`. Errors during the write are
swallowed (log only) — losing the summary shouldn't recursively crash
a run that was otherwise fine. Token counts are `null`: the current
`extractText` path doesn't surface OpenCode usage metadata.

**RepoService.** New `gitStatus(clonePath)` returns
`{ porcelain, changedFiles }`. Swallows errors so a malformed clone
still gets a summary.

**UI.** `SummaryCard` renders at the top of the Board tab when
`phase ∈ {completed, stopped, failed}` and a summary is present. Shows
stop-reason badge (green/gray/amber/red), key stats in a grid, and a
Details toggle that reveals per-agent turns+tokens and the raw git
status.

**Verified (unit):** `summary.test.ts` — 18 tests covering every
stopReason branch, wall-clock clamp, board counts passthrough,
git-status truncation, per-agent defensive copy, and JSON roundtrip.
115 → 133 server tests, all green; `tsc --noEmit` clean both sides.

## Phase 10 — Polish + documentation  **[committed: `6f7a281`]**

Paper cuts that were acceptable during phases 3–9 but shouldn't be there
once blackboard is a shipped preset.

**Pattern catalog flipped.** `docs/swarm-patterns.md` entry #7
(blackboard) moved from `[~] implementation target` to
`[x] shipped (v1 preset)` with a pointer to the plan + changelog. The
roadmap table's row 1 now reads `Blackboard ✓ shipped` so a reader
landing on `swarm-patterns.md` cold doesn't have to guess which entries
are live.

**SetupForm flip.** `web/src/components/SetupForm.tsx` changed the
`blackboard` preset from `status: "planned"` to `status: "active"` so
**Start** is enabled when it's selected. The summary text was reworded
from generic ("Agents pull todos from a shared board") to
planner-vs-worker specific ("Planner posts todos; workers claim and
commit in parallel"). Other presets in the dropdown remain `planned`
and still disable Start.

**BlackboardHelp (inline, collapsible).** New `<BlackboardHelp />`
renders under the Pattern field only when blackboard is selected. Four
paragraphs: planner/worker split, optimistic CAS at commit, stale →
replan with R-badge counter, and the three hard caps (20 min / 20
commits / 30 todos — numbers pulled from `caps.ts` directly so the
block is grep-verifiable). Collapsed by default so first-time users
aren't hit with a wall of text before clicking the row.

**BoardView column tooltips.** Each column header in
`web/src/components/BoardView.tsx` grew a `title` attribute explaining
what the column represents. Stale's tooltip specifically names the
CAS-rejection → planner-rewrite flow and the R1/R2 badge, answering
the question "why did my todo turn red?" without requiring the user to
find the docs. Cursor switches to `cursor-help` over the header so
the tooltip is discoverable.

**README blackboard section.** `README.md` got:
- A second bullet under the intro ("Blackboard (optimistic + small units)").
- The prior **How the swarm discusses** heading renamed to
  **How the round-robin preset works**.
- A new **How the blackboard preset works** section — seven numbered
  points covering planner/worker split, atomic todos, optimistic CAS,
  stale-replan, hard caps, `summary.json` artifact, and the Board tab.
- Usage walkthrough grew a **Pattern** step (step 3) and noted that
  `rounds` is ignored by the blackboard preset.
- Limitations rewritten: round-robin is discussion-only (not the whole
  app), blackboard diffs are full-file replacements (not patches),
  `summary.json`/`board-final.json` survive a restart on the blackboard
  path.

**Parent-folder input.** Previously the **Local path** field had to be
the exact clone directory (`C:\...\runs\is-odd`); if the user typed the
parent, the repo got cloned _at_ that path, mixing its files with
siblings. Now:
- REST POST body takes `parentPath` instead of `localPath`.
- `deriveCloneDir(repoUrl, parentPath)` in `server/src/services/RepoService.ts`
  parses the URL, strips `.git`, and joins with the parent — the route
  handler hands the full clone path to the orchestrator as
  `RunConfig.localPath` (internal name unchanged so downstream code is
  untouched). 9 tests cover URL variants, trailing-slash handling,
  `.git` stripping, and failure modes.
- SetupForm field relabeled **Parent folder** with a live preview hint
  showing the resolved clone path (`…/runs/is-odd`). Default changed
  from `runs\is-odd` to `runs`.
- README walkthrough step 2 rewritten to match.

**Verified.** `tsc --noEmit` clean on both sides; 142/142 server tests
green (133 → 142 from the 9 new `deriveCloneDir` tests).

---

## Phase 11a — ExitContract types + `criterionId` on `Todo` **[committed: `5381fce`]**

First cut at the exit-contract design — types only, no behavior change.
The goal across Phase 11 is to replace drain-exit (stop when the board
has no open todos) with contract-satisfied termination (stop when a
declared set of criteria are each marked `met` or `wont-do`). Phase 11a
just lays the type foundation so 11b–11d can land as pure behavior PRs
without touching shapes again.

**Types.** `server/src/swarm/blackboard/types.ts` grew two new
interfaces and extended one:

- `ExitCriterion` — `{ id, description, expectedFiles, status, rationale?, addedAt }`
  where `status: "unmet" | "met" | "wont-do"`. The three-valued status
  is deliberate: `wont-do` is what the auditor emits for criteria that
  are out of scope or already handled by prior work (not a failure,
  not a pass — a closed verdict that ends the obligation without a
  commit).
- `ExitContract` — `{ missionStatement, criteria: ExitCriterion[] }`.
  Mission statement is the seed goal; criteria accumulate across the
  run (first-pass planner emits the initial set; auditor can add more
  as it learns).
- `Todo.criterionId?: string` — optional link from a todo back to the
  contract criterion it's intended to satisfy. `undefined` for
  discussion-only or exploratory todos the planner adds outside the
  contract.

`Board.postTodo` accepts an optional `criterionId` and stores it on
the todo. `copyTodo` already uses `...todo` spread, so defensive copies
preserve it for free. No other Board method is aware of criterion
links yet — that's Phase 11c's job.

**Mirror.** `web/src/types.ts` mirrors the new shapes so future
`contract_updated` WS events and a contract panel can land without
another cross-boundary type migration.

**Tests.** Two new `Board.test.ts` cases:
- `persists criterionId when provided` — round-trip through
  `postTodo` → `listTodos` + the `todo_posted` event carries it.
- `leaves criterionId undefined when omitted` — legacy callers
  (`BlackboardRunner.ts`, `routes/dev.ts`) keep working without change.

**Deliberately out of scope for 11a.** No prompt changes, no auditor,
no first-pass contract emission, no UI panel, no `contract_updated`
event variant. Those are 11b–11e.

**Verified.** `tsc --noEmit` clean on both sides; 144/144 server tests
green (142 → 144 from the 2 new `criterionId` passthrough tests).

---

## Phase 11b — First-pass contract emission + UI panel  **[committed: `1f679d4`]**

Planner emits an `ExitContract` (mission + criteria) once at the top of
`planAndExecute`, before it posts todos. The contract is broadcast via
a new `contract_updated` WS event, stored in the web Zustand store,
and rendered in a new **Contract** tab alongside Transcript and Board.

Behavior is still drain-exit — the contract is informational in 11b.
Gating run termination on contract satisfaction lands in Phase 11c
(auditor loop) and won't need another type or transport change.

**New prompt module.** `server/src/swarm/blackboard/prompts/firstPassContract.ts`:

- `FIRST_PASS_CONTRACT_SYSTEM_PROMPT` — asks for a single JSON *object*
  shaped `{missionStatement, criteria: [{description, expectedFiles}]}`.
  Emphasizes that criteria are outcomes ("README has a Quick Start
  section") not implementation steps.
- `buildFirstPassContractUserPrompt(seed)` — reuses the existing
  `PlannerSeed` (repo URL, clone path, top-level dirs, README excerpt)
  so the contract has the same context the planner has.
- `buildFirstPassContractRepairPrompt(prev, err)` — same one-shot repair
  loop as `planner.ts`.
- `parseFirstPassContractResponse(raw)` — zod-validated parser. Envelope
  is an object (not an array like `planner`), so the fence-stripper
  targets `{...}`. Drops individual invalid criteria without failing
  the whole contract (mirrors planner's per-todo drop pattern).

Cap per criterion: `expectedFiles.length ≤ 4` (planner's todo cap is
≤ 2; contract criteria can span a little wider). Contract cap: ≤ 12
criteria total.

13 new tests in `prompts/firstPassContract.test.ts` cover bare object,
fenced JSON, prose-wrapped JSON, empty criteria, array-instead-of-object,
missing mission, invalid-criteria drop, unparseable JSON, and prompt
content sanity checks.

**Runner wiring.** `BlackboardRunner.runFirstPassContract(planner, seed)`
runs immediately before `runPlanner` inside `planAndExecute`'s try block
(so crashes are caught the same way). It promptAgent → parse → one
repair on failure → parse again → give up silently if still invalid.
On success, `buildContract(parsed)` stamps `c1`/`c2`/... IDs, sets all
statuses to `unmet`, and stamps a single `addedAt`. The contract is
stored in `this.contract` (for Phase 11c) and broadcast via a defensive
clone.

If the prompt fails or the repair loop gives up, `this.contract` stays
undefined and the run proceeds as before — no behavior change from the
user's perspective. The transcript gets a `"Proceeding without a
contract."` line so this case is visible in the log.

**Server types.** `server/src/types.ts` imports `ExitContract` from the
blackboard types module and adds `{ type: "contract_updated"; contract }`
to `SwarmEvent`.

**Web wiring.** `web/src/types.ts` mirrors the event variant (types were
already mirrored in 11a). `web/src/state/store.ts` grows:
- `contract?: ExitContract` field + `setContract(c)` action
- Cleared in `reset()` along with the rest
- Dispatched from `useSwarmSocket.ts` on `contract_updated`

**UI panel.** `web/src/components/ContractPanel.tsx` — read-only view:
- Mission statement at top as a body-weight line
- Criteria list with per-row status badge (unmet / met / wont-do),
  monospace `id`, description, expected-file chips, and an optional
  rationale italicized beneath
- Summary line at the top of the list: "N met · M unmet · K wont-do"
- Empty-state message when no contract has arrived yet

`SwarmView.tsx` grew a third tab button (**Contract**) between Board
and the say-input, following the existing `TabButton` pattern.

**Deliberately out of scope for 11b.** No auditor, no re-emission of
`contract_updated` mid-run (so status stays `"unmet"` for the whole
run), no contract-satisfied termination, no seed goal field on
SetupForm. Those are 11c–11e.

**Verified.** `tsc --noEmit` clean both sides; 157/157 server tests
green (144 → 157 from the 13 new `firstPassContract` parser + prompt
tests). HMR picked up every edit cleanly on the running dev server;
both ports returned 200.

---

## Phase 11c — Auditor loop + contract-satisfied termination  **[committed: `69a99e3`, `18588b9`]**

Runs now terminate when the planner's exit contract is satisfied (every
criterion is `"met"` or `"wont-do"`) instead of at the first board
drain. When workers drain with unmet criteria still open, the planner
agent is re-prompted in an **auditor** role: per-criterion verdicts
drive the next round of todos, and the drain-audit-repeat loop keeps
going until the contract is resolved or the auditor cap trips.

Back-compat: runs with no contract (first-pass prompt failed to parse
after repair) or with a zero-criterion contract fall back to the
Phase 10 drain-exit behavior — no auditor is invoked.

**New prompt module.** `server/src/swarm/blackboard/prompts/auditor.ts`:

- `AUDITOR_SYSTEM_PROMPT` — asks for a single JSON object shaped
  `{verdicts: [...], newCriteria?: [...]}` where every verdict carries
  `id` / `status` (`"met"` / `"wont-do"` / `"unmet"`) / `rationale`, and
  `"unmet"` verdicts MUST include 1–4 todos. Also permits the auditor to
  discover brand-new criteria it thinks the initial contract missed.
- `buildAuditorUserPrompt(seed)` — seed carries mission statement,
  unmet + resolved criteria, and recent committed/skipped todos and
  findings (each capped at the last 40 items so prompt size stays bounded
  on long runs). Also includes current audit invocation number so the
  model can see the cap approaching.
- `buildAuditorRepairPrompt(prev, err)` — same one-shot repair loop as
  the planner and first-pass contract paths.
- `parseAuditorResponse(raw)` — zod-validated, fence-stripping, with the
  individual-item drop pattern: a single malformed verdict or new
  criterion drops without failing the whole envelope. Drops are surfaced
  in the `dropped` array on success.

19 new tests in `prompts/auditor.test.ts` cover bare object, fenced JSON,
prose-then-object, mixed verdict statuses, newCriteria passthrough,
bare-array rejection, missing-verdicts rejection, non-array-newCriteria
rejection, per-verdict invalid-status drop, unmet-with-empty-rationale
drop, newCriteria cap drop, unparseable JSON, and system/user/repair
prompt content sanity (including the 40-item context truncation).

**Runner wiring.** `BlackboardRunner` grows a small handful of pieces:

- `AUDITOR_MAX_INVOCATIONS = 5` constant — backstop against an auditor
  that can't converge. When hit, the run still terminates as `"completed"`
  but with a `completionDetail` noting the cap so the UI and summary
  artifact explain why unresolved criteria remain.
- `auditInvocations` counter + `completionDetail?: string` fields on
  the class (both reset in `start()`).
- `runAuditedExecution(planner, workers)` replaces the single
  `runWorkers(workers)` call inside `planAndExecute`. It loops:
  drain with runWorkers → check `allCriteriaResolved()` → if so, set
  `completionDetail = "all contract criteria satisfied"` and return;
  else check the invocation cap, else run the auditor and loop again.
  Also short-circuits when the auditor produces no new work and no
  criteria transitioned (prevents an empty-spin loop).
- `runAuditor(planner)` mirrors `runFirstPassContract`'s pattern:
  promptAgent → parse → one repair attempt → parse again → apply or
  log and skip. Each invocation increments `auditInvocations`.
- `buildAuditorSeed()` collects board state into the `AuditorSeed`
  shape — committed todos (with files, sorted by commit time), skipped
  todos (with reasons), and findings (all entries, both orderings left
  for the 40-item truncation inside `buildAuditorUserPrompt`).
- `applyAuditorResult(result, planner)` walks the verdicts in order:
  - Unknown criterion IDs are logged and ignored.
  - Already-resolved criteria are skipped silently.
  - `"met"` / `"wont-do"` flip status + rationale on the criterion.
  - `"unmet"` posts each todo via `board.postTodo` with the auditor's
    `criterionId` linking back to the criterion. The criterion stays
    `"unmet"` — the next audit round decides its fate.
  - `"unmet"` with zero todos (schema allows it even though the prompt
    forbids it) is auto-converted to `"wont-do"` with an auto-rationale
    so the criterion can't wedge the loop.
  - `newCriteria[]` entries are appended with `c{N+1}` IDs,
    `status: "unmet"`, current `addedAt`. Their todos are posted in
    the next audit round (can't be posted in the same call since their
    IDs don't exist until after this pass).
- Every apply call re-emits `contract_updated` via a defensive clone,
  so the Contract panel updates live as statuses flip and new criteria
  land.

**Summary artifact.** `server/src/swarm/blackboard/summary.ts` grows
two fields on both `BuildSummaryInput` and `RunSummary`:

- `completionDetail?: string` — flows into `stopDetail` on the
  `"completed"` branch. Lets the UI distinguish "all contract criteria
  satisfied" from "auditor invocation cap reached" from "auditor
  produced no new work" without overloading `stopReason`. Crucially,
  `completionDetail` is IGNORED on the cap/user/crash branches so a
  stale completion note can't mislead.
- `contract?: ExitContract` — the final contract state (with every
  verdict applied) gets serialized into `summary.json` and broadcast
  on the `run_summary` WS event. Written through a defensive
  clone (`cloneContract`) so post-summary mutation can't leak into the
  artifact.

4 new tests in `summary.test.ts` exercise the completionDetail +
contract paths (happy path, cap overrides completionDetail, defensive
copy, undefined-contract fallthrough).

**Web wiring.** `web/src/types.ts` grows `contract?: ExitContract` on
`RunSummary` to mirror the server. The existing Contract tab picks up
live status flips for free via the `contract_updated` dispatch added
in 11b — no UI code changes needed in 11c.

**Deliberately out of scope for 11c.** No pivot verdict on the
replanner (Phase 11d) — the auditor can only propose new todos, not
replace an in-flight stale one. No user-supplied mission goal on the
SetupForm (Phase 11e) — the mission still comes from the planner's
reading of the repo. No UI summary badge for `completionDetail` yet;
the string is in `run_summary` and the artifact, but rendering lives
in a future polish pass.

**Verified.** `tsc --noEmit` clean both sides; 180/180 server tests
green (157 → 180 from the 19 new `auditor` parser + prompt tests and
4 new `summary` contract tests). HMR picked up every edit cleanly on
the running dev server; both ports returned 200.

---

## Phase 11c hardening — patch-based worker diffs + windowed prompts  **[committed: `42b9789`, `18d0fad`, `2519e54`, `41bb7db`]**

Phase 11c shipped the auditor loop but an E2E run on a medium-sized repo
(`phase11c-medium-v5`) stopped at the 20-min wall-clock cap with only one
commit. Root cause: the worker prompt dumped the full contents of every
expected file, then asked the worker to echo the full new file back as
`{file, newText}`. On a 49KB README that meant ~50KB in and ~50KB out per
edit. Combined with `glm-5.1:cloud`'s response latency, every README-touching
todo blew past undici's 5-min header timeout (`UND_ERR_HEADERS_TIMEOUT`).
c2 ended the run unmet.

This arc replaces full-file diffs with Aider-style search/replace hunks
and caps the worker's *input* view of large files at head+tail windows.

**Unit 1 — pure `applyHunks` logic.** `server/src/swarm/blackboard/applyHunks.ts`:

- Discriminated `Hunk` union: `{op:"replace", file, search, replace}`,
  `{op:"create", file, content}`, `{op:"append", file, content}`.
- `applyHunks(currentContents, hunks)` returns `{ok:true, newTextsByFile}`
  or `{ok:false, error}`. Hunks are applied *sequentially* per file — each
  hunk sees the previous one's output, so two replace hunks against the
  same file compose predictably.
- `replace` enforces exact-single-match: ambiguous anchors fail closed
  with a clear reason. `create` rejects if the file already exists.
  `append` tolerates either a prior-hunk output or the on-disk content.
- `applyHunks.test.ts` — 20 tests including sequential same-file composition,
  ambiguous-anchor rejection, create-on-existing rejection, and the
  append-to-new-file-from-create combo.

**Unit 2 — worker emits hunks; runner applies via `applyHunks`.** One
checkpoint because the schema change in `prompts/worker.ts` ripples into
`BlackboardRunner.commit` — a staggered commit would have left a broken
intermediate state.

- `prompts/worker.ts` — schema rewritten from `{diffs:[{file,newText}]}` to
  `{hunks:[Hunk], skip?:string}`. Per-field caps (`SEARCH_MAX`/`REPLACE_MAX`
  = 50K, `CONTENT_MAX` = 200K); `MAX_HUNKS = 8`. `FILE_FIELD` still enforces
  `expectedFiles` membership. Worker may now issue multiple hunks against
  the same file (explicitly allowed — that's the point of hunks).
- `prompts/worker.test.ts` — 22 tests covering each op's happy path,
  mixed-op batches, sequential same-file hunks, and every rejection path
  (empty `search`, missing `content`, unknown `op`, blank `file`,
  file-not-in-`expectedFiles`, etc.).
- `WORKER_SYSTEM_PROMPT` — teaches the three ops explicitly, stresses
  exact-single-match on replace, and tells the worker that files above
  the windowing threshold arrive as head+marker+tail (see Unit 3).
- `BlackboardRunner.commit` — after parse, runs `applyHunks(contents, parsed.hunks)`,
  then zero-file and UTF-8 BOM checks now run against *post-apply* text,
  and the write loop iterates `resultingDiffs` from `applied.newTextsByFile`.
  Empty-hunks-without-skip is a stale event. Commit summary line reports
  hunk count + post-apply sizes per file.
- **Integration test.** `workerPipeline.test.ts` (12 tests) exercises
  parse → apply → write on a real tmpdir: happy paths for each op and
  mixed batches, plus atomicity proofs that a parse failure, an ambiguous
  anchor, an apply-step rollback, and a file-outside-`expectedFiles`
  request all leave zero bytes on disk.

**Unit 3 — windowed file views.** `server/src/swarm/blackboard/windowFile.ts`:

- `windowFileForWorker(content)` returns `{full:true, content}` when
  `content.length ≤ 8000`, else `{full:false, content: head(3KB) + marker + tail(3KB)}`.
  Marker is prose so a human reading the transcript sees the gap, and
  tells the worker to use `op:"append"` for EOF additions or `op:"replace"`
  with an anchor visible in the shown head/tail.
- Pure function; `windowFile.test.ts` (11 tests) covers boundary, head/tail
  byte preservation, marker content, the 49KB smoking-gun case, determinism,
  and the never-longer-than-input invariant.
- `buildWorkerUserPrompt` (in `prompts/worker.ts`) wraps each `fileContents`
  value through `windowFileForWorker` and labels the header `full` or
  `WINDOWED`. A 49KB README now lands as ~6.5KB of prompt.

**E2E validation — `phase11c-medium-v6` vs `-v5`.** Same repo, same
contract template, same model. v5 baseline → v6 after hardening:

| | v5 | v6 |
|---|---|---|
| Wall clock | 24.5 min (`cap:wall-clock`) | 14.5 min (`completed`) |
| Commits | 1 | 13 |
| Stale events | 4 | 2 |
| Files changed | 2 | 7 |
| Contract `unmet` at stop | 1 (`c2`, README timeout) | 0 |
| `UND_ERR_HEADERS_TIMEOUT` | 1 (killed `c2`) | 0 |
| 49KB+ README edits | timed out | 6 successful replace hunks |

All three hunk ops exercised live: `replace` on a 49 → 54KB README,
`append` on a 71 → 74KB KNOWN_LIMITATIONS.md, `create` for three new
`*.test.ts` files. Worker declines arrive as well-formed
`{"hunks":[], "skip":"..."}` and the replanner converts them to skipped
status (no stale noise).

**Known issue surfaced (not a regression, separate unit).** The replanner
re-spawns the same unmet criterion after every audit cycle without
consulting current file state, so when multiple agents each commit a
hunk against the same criterion, their blocks stack instead of compose.
In v6 this showed up as four consecutive `### Environment Variables`
tables under a single `## Configuration` heading in the README, and the
auditor (fairly) ruled `c3` `wont-do`. Tracked as the next hardening unit.

**Verified.** `tsc --noEmit` clean; 274/274 server tests green across
53 suites. New suites added by this arc: `applyHunks`, `workerPipeline`
(parse → apply → write integration), `windowFile`; the `worker` suite
was rewritten around the hunk schema. v6 E2E stop reason `completed`,
stopDetail `all contract criteria satisfied`.

---

## Phase 11c hardening — auditor file-state awareness  **[committed: `3570f66`, `85d0a4d`, `1cd1ee0`]**

Phase 11c hardening arc (Units 1–3) fixed the *transport* problem — workers
could now edit large files without timing out. `phase11c-medium-v6` then
surfaced a *reasoning* problem: the auditor kept re-spawning the same unmet
criterion after every audit cycle because it decided verdicts from commit
history alone, with no view of the current files on disk. Multiple agents
each committed a hunk against the "add env-var table" criterion and their
blocks stacked into four consecutive `### Environment Variables` tables
under one `## Configuration` heading. The v6 auditor saw four commits of
"add env-var table" work and (correctly, given the information it had) kept
asking for another pass.

This arc teaches the auditor to read the current file state before
deciding, and to recognize consolidation-vs-re-add when it sees duplicate
blocks.

**Unit 5a — AuditorSeed plumbing.** `server/src/swarm/blackboard/prompts/auditor.ts`:

- New `AuditorFileStateEntry` interface — `{exists, content, full, originalLength}`.
- New pure `buildAuditorFileStates(fileContents)` — runs each entry through
  `windowFileForWorker` (same 8KB/head+tail logic as Unit 3). Missing files
  become `{exists:false, content:"", full:true, originalLength:0}`;
  present files preserve the windowing output verbatim.
- `AuditorSeed` gains `currentFileState: Record<string, AuditorFileStateEntry>`.
- `auditor.test.ts` +7 tests covering empty, null, small-file passthrough,
  large-file windowing, mixed batches, determinism, and empty-string.

`BlackboardRunner.buildAuditorSeed` became async so it can call the
existing `readExpectedFiles` helper on the union of `expectedFiles` across
all `"unmet"` criteria. Callsite at `runAuditor` gained an `await`.

**Unit 5b — Auditor prompt rewrite.** Same file; the system prompt now
opens with a DECISION PROCESS block:

1. **Read each file's current state first.** The `currentFileState` section
   shows exactly what is on disk right now.
2. **Judge each criterion against that state, not against the commit log.**
3. **If a criterion appears satisfied but stacked/duplicated** (e.g. the
   same table appears twice), emit `"unmet"` with a CONSOLIDATE or REPAIR
   todo that removes the duplicate — do NOT re-emit a todo that would
   add a third copy.
4. **For files shown as WINDOWED (head + marker + tail)**, treat the
   middle as unseen; rely on the head/tail for structural decisions and
   only claim `"met"` if the evidence is in the visible window.

`buildAuditorUserPrompt` grew a new section between unmet criteria and
resolved criteria:

```
Current file state:
- path/to/file.md (does not exist on disk)
- README.md (49231 chars, WINDOWED — head + marker + tail)
- package.json (783 chars, full)
  <file contents>
```

Labels are sorted deterministically for diff-stability of the prompt text.

`auditor.test.ts` +8 tests (3 system prompt: file-state primacy, duplicate
recognition, windowing; 5 user prompt: section presence, missing-file
label, WINDOWED label+body, sorted order, empty-state graceful fallback).

**Unit 5c — E2E validation `phase11c-medium-v7`.** New mission template
(config validation + supervisor crash recovery + tests), same repo. The
machine slept partway through, so the wall-clock cap fired on wake —
treat the `31M ms` value in `summary.json` as sleep-distorted. Productive
execution was ~13 minutes before sleep, matching what we saw live.

| | v6 | v7 |
|---|---|---|
| stopReason | `completed` | `cap:wall-clock` (sleep-distorted) |
| productive wall | 14.5 min | ~13 min (machine slept after) |
| commits | 13 | 5 |
| totalTodos | 15 | 8 |
| skippedTodos | 2 | 1 (intelligent skip, see below) |
| criteria met | 2 / 5 | 4 / 6 |
| criteria wont-do | 3 | 0 |
| criteria unmet at end | 0 | 2 (test-file criteria, see gap) |

**The Unit 5b signal landed.** v7's auditor rationales cite specific file
contents — "src/config.ts has validateConfig checking REQUIRED_FIELDS",
"KNOWN_LIMITATIONS.md §40 documents attachWorkerExitHandler in
supervisor.ts" — where v6's rationales were generic ("the required
change is present in the committed todos"). No stacked duplicate blocks
appeared anywhere in the v7 output. The clearest positive: `c2` (LLM
error handling) was marked `"met"` with rationale "brain.ts already
implements exponential-backoff retry on LLM failure, a 5-failure circuit
breaker, escalating pause delays, and fallback to directOllamaCall — the
replanner skipped the matching TODO for this reason" — file-state
awareness recognizing that the functionality already existed.

**Gap surfaced — `expectedFiles: []` blind spot.** Two criteria (`c4`,
`c5` — test-file existence) had empty `expectedFiles` arrays on the
contract, so `readExpectedFiles([])` returned `{}` and
`currentFileState` was empty. The auditor honestly reported "file
content was not shown; need to verify" and left both `"unmet"` — even
though both test files (`src/__tests__/config.test.ts` 7.8KB and
`src/__tests__/supervisor.test.ts` 8.9KB) were committed by the same
run. Honest behavior, but leaves easy wins on the table. Tracked as
Unit 5d.

**Verified.** `tsc --noEmit` clean; 289/289 server tests green (274 +
15 new from Units 5a/5b). v7 live behavior matched the test suite:
intelligent replanner skip fired once at t+~14m, no duplicate-block
stacking anywhere, auditor rationales cite file contents.

---

## Phase 11c hardening — auditor `expectedFiles: []` fallback + seed extraction  **[committed: `5983048`, `da374b8`]**

Closes the blind spot Unit 5c surfaced: an unmet criterion with empty
`expectedFiles` had no file state to feed the auditor, so honest "can't
see" verdicts piled up instead of `"met"`. Two units:

**Unit 5d — `resolveCriterionFiles` fallback.** In
`server/src/swarm/blackboard/prompts/auditor.ts`:

- `CommittedTodoSummary` gains `criterionId?: string` — already plumbed
  on `Todo` since Phase 11a, now carried into the auditor's view so a
  committed todo can be linked back to the criterion it was addressing.
- New pure `resolveCriterionFiles(criterion, committed)` with a
  three-step resolution:
  1. If the criterion has its own `expectedFiles`, return them verbatim
     (happy path — no inference needed).
  2. Otherwise, union the `expectedFiles` of committed todos whose
     `criterionId` matches, newest-first, capped at
     `AUDITOR_FALLBACK_FILE_MAX = 4` files.
  3. Otherwise, fall back to the most recent
     `AUDITOR_FALLBACK_RECENT_COMMITS = 4` *unlinked* committed todos
     (those with no `criterionId` at all — todos with a different
     `criterionId` are excluded, since they belong to another criterion).
     Same 4-file cap.
- `BlackboardRunner.buildAuditorSeed` calls the new helper when mapping
  unmet criteria: `{...c, expectedFiles: resolveCriterionFiles(c, committed)}`.
  The underlying `ExitContract` is NOT mutated — only the view handed
  to the auditor is decorated.

`auditor.test.ts` +12 targeted tests covering: passthrough, defensive
copy, linked fallback, dedup across linked todos, file-count cap,
unlinked fallback, different-`criterionId` exclusion, recent-commits
cap, linked-preferred-over-unlinked, empty-result terminal state,
determinism, missing-`committedAt` fallback.

**Unit 5e — `buildAuditorSeedCore` extraction + E2E validation.**
The composition contract → committed-summaries →
`resolveCriterionFiles` → `readFiles` → `buildAuditorFileStates` → seed
used to live in a 73-line async method on `BlackboardRunner`, which
made the full pipeline awkward to test without instantiating a runner
+ board + agents. Extracted the composition into a pure
`buildAuditorSeedCore(input)` with a `readFiles` callback so the I/O
seam is injectable:

```ts
export interface BuildAuditorSeedInput {
  contract: ExitContract;
  todos: Todo[];
  findings: Finding[];
  readFiles: (paths: string[]) => Promise<Record<string, string | null>>;
  auditInvocation: number;
  maxInvocations: number;
}
```

`BlackboardRunner.buildAuditorSeed` is now a 9-line wrapper that passes
`(paths) => this.readExpectedFiles(paths)` as the callback and hands
the rest of the inputs through. Behavior-preserving refactor: no
semantic change, but the whole audit-pipeline can now be validated
with synthetic contracts + stub `readFiles` rather than end-to-end.

`auditor.test.ts` +13 tests validating the Unit 5d fallback path
end-to-end. The linchpin test replicates the v7 `c4`/`c5` scenario
directly: a contract with a single unmet criterion (`c4`, empty
`expectedFiles`), one committed todo (`criterionId: "c4"`,
`expectedFiles: ["src/brain/brain.test.ts"]`), and a stub `readFiles`
returning test-file content. The assertions verify that
`buildAuditorSeedCore` infers the file via step 2 of
`resolveCriterionFiles`, calls `readFiles(["src/brain/brain.test.ts"])`
exactly once, and produces a `currentFileState` where the inferred
file exists with its real content — which is precisely what was
missing in v7. Other tests cover: happy-path passthrough, unlinked
fallback, the "no files resolvable at all" terminal case (readFiles
NOT called), batched deduped reads across multiple unmet criteria,
the UNMET-only read policy (resolved criteria don't trigger reads),
committed/skipped partitioning, findings passthrough, resolved
criteria as context-only, mission/invocation passthrough, null →
non-existent, large-file windowing (shared view with worker), and
non-mutation of the input contract.

**E2E validation run `phase11c-medium-v8`.** Mission: add unit tests
for core orchestration logic + enforce strict TypeScript + tighten
lint/typecheck pipelines + add CONTRIBUTING.md.

| | v7 | v8 |
|---|---|---|
| stopReason | `cap:wall-clock` (sleep-distorted) | `completed` |
| stopDetail | — | `all contract criteria satisfied` |
| wallClockMs | 31,273,500 (sleep) / ~13 min productive | **138,340 (2 min 18 sec)** |
| commits | 5 | 6 |
| totalTodos | 8 | 6 |
| staleEvents | 0 | 0 |
| skippedTodos | 1 (intelligent) | 0 |
| criteria met | 4 / 6 | **5 / 6** |
| criteria wont-do | 0 | 1 (typecheck — rule 8, as designed) |
| criteria unmet at end | 2 | **0** |

v8 completed cleanly on the first pass with zero stales and zero
skips, and every `"met"` verdict's rationale quotes the file
contents directly — e.g. c3 rationale: `tsconfig.json shows "strict":
true, "noUncheckedIndexedAccess": true, "noImplicitOverride": true`.
The one `"wont-do"` (c4: "running `bun run typecheck` exits zero")
correctly invoked system-prompt rule 8: "Verifying that tsc exits
zero with no errors requires running the TypeScript compiler, which
workers cannot do."

**Validation-gap note.** v8's planner emitted explicit `expectedFiles`
on every criterion it wrote, so the Unit 5d fallback path wasn't
exercised end-to-end at runtime — the fast/clean result is evidence
of no-regression, not of the fallback firing. That's why Unit 5e
added the targeted `buildAuditorSeedCore` tests: they exercise the
fallback deterministically with synthetic fixtures shaped like the
v7 scenario, without waiting for a planner to emit an empty
`expectedFiles` array again.

**Verified.** `tsc --noEmit` clean; 314/314 server tests green
(289 + 12 Unit 5d + 13 Unit 5e). v8 artifact:
`runs/phase11c-medium-v8/multi-agent-orchestrator/summary.json` —
preserved for comparison.

---

## Unit 6a — Planner/contract grounding via real repo file list  **[committed: `daec341`]**

Addresses known-limitation #3 (planner grounding). The v7 incident where the
contract emitted `expectedFiles: []` on criteria it couldn't bind to files had
a deeper cause than the auditor's handling: the planner was working from the
top-level directory listing + README excerpt alone, so it literally did not
know which files to name. This unit gives the planner and the first-pass
contract writer the real file list.

- `server/src/services/RepoService.ts` — added `listRepoFiles(clonePath, {maxFiles=150})`, a BFS walk that returns up to 150 repo-relative paths (forward slashes, one dir at a time). Also exported:
  - `LIST_REPO_IGNORED_DIRS` — `.git`, `node_modules`, `dist`, `build`, `out`, `coverage`, `.cache`, `.next`, `.turbo`, `.nuxt`, `.parcel-cache`, `.venv`, `__pycache__`, `.pytest_cache`, `target`, `vendor`, and VCS siblings. One shared set so tests can assert "the high-frequency offenders are ignored" without re-encoding the list.
  - `isLikelyBinaryPath(filename)` + `BINARY_EXTENSIONS` — skips images/archives/fonts/executables/media/design/db files from the listing so the planner isn't asked to edit `.png`s.
  - BFS on purpose: shallow files (`README.md`, `package.json`, `src/index.ts`) surface before deep ones, matching what a human glancing at a repo sees first.
- `server/src/services/RepoService.test.ts` — 10 new tests covering: binary-extension positive/negative, ignored-dirs coverage regression guard, forward-slash normalization, ignored-dirs enforcement, binary-file skipping, BFS shallow-first with cap, sorted-within-dir determinism, missing-path graceful [], same-input determinism.
- `server/src/swarm/blackboard/prompts/planner.ts` — `PlannerSeed` gained `repoFiles: string[]`. `buildPlannerUserPrompt` renders a `=== REPO FILE LIST ===` section (one path per line so the model can quote verbatim). `PLANNER_SYSTEM_PROMPT` gained rule 9: every `expectedFiles` entry must either appear verbatim in the list OR be a new file whose parent directory appears there. Removed the older weaker "do not invent files" line — rule 9 subsumes it.
- `server/src/swarm/blackboard/prompts/firstPassContract.ts` — symmetric changes: `buildFirstPassContractUserPrompt` renders the same REPO FILE LIST section; `FIRST_PASS_CONTRACT_SYSTEM_PROMPT` gained rule 10 (same grounding rule, with an explicit "when unsure, prefer `expectedFiles: []`" nudge so the auditor's linked-commit fallback stays the recovery path rather than the default).
- `server/src/swarm/blackboard/BlackboardRunner.ts` — `buildSeed()` now calls `repos.listRepoFiles(clonePath, {maxFiles: 150})` and populates `repoFiles`. Empty-list case degrades to the old behavior (user prompt shows "no files listed"). No API break — callers didn't see the old seed shape directly.
- `server/src/swarm/blackboard/prompts/firstPassContract.test.ts`, `planner.test.ts` — seed fixtures gained `repoFiles`; 3 new tests per file: REPO FILE LIST is rendered with one path per line, empty-repoFiles falls back gracefully, system prompt references "REPO FILE LIST".

**Why this matters for the failure mode that motivated it.** v7 c4/c5 came
back unmet because the contract named files the auditor couldn't find. Unit
5d gave the auditor a linked-commit fallback, Unit 5e made that fallback
testable, and Unit 6a attacks the root cause one layer up — the contract
shouldn't be emitting unbindable paths in the first place when a real file
list is right there.

**Verified.** `tsc --noEmit` clean; 330/330 server tests green (314 before
+ 10 Unit 6a RepoService + 3 planner prompt + 3 contract prompt). No new
E2E run yet; that's the Unit 6a→6b boundary check.

---

## Unit 6b — Enforce path grounding at contract + todo parse time  **[committed: `478e45b`]**

Unit 6a gave the planner and contract-writer a real file list and told them (via
system-prompt rules 9 and 10) not to invent paths. The v9 E2E run
(`runs/phase11c-medium-v9/`) showed those rules are *advisory*: the planner
dutifully emitted `src/tests/token-tracker.test.ts` and three sibling paths
despite the REPO FILE LIST showing colocated tests (`src/brain/brain.test.ts`
lives right next to `src/brain/brain.ts`). The contract criteria inherited the
same invention, and `writeFileAtomic` happily created the missing `src/tests/`
directory — so the run "succeeded" while installing tests in a directory that
doesn't match the repo's convention. This unit replaces the advisory rule with
code-level enforcement at parse time.

- `server/src/swarm/blackboard/prompts/pathValidation.ts` — pure module, no I/O. `classifyPath(path, repoFiles)` returns one of three verdicts:
  - `existing` — verbatim match in `repoFiles` (edit-an-existing-file).
  - `plausible-new` — path not in the list, but parent dir *is* in the list (or the path is at repo root). The worker will create it; `writeFileAtomic` handles missing parents.
  - `suspicious` — path not in the list *and* parent dir has no sibling in the list. This is the v9 failure mode; enforcement strips these before they reach the board.
  `classifyExpectedFiles(paths, repoFiles)` runs the classifier over a batch and returns `{accepted, rejected}` with a human-readable reason per rejection. Backslash-normalized so `src\tests\foo.ts` is classified the same as `src/tests/foo.ts` (Windows models occasionally emit mixed separators).
- `server/src/swarm/blackboard/prompts/pathValidation.test.ts` — 15 tests across 7 describe blocks: verbatim-existing (root + nested), plausible-new (root, colocated-test, inside-src), the exact v9 suspicious regression (`src/tests/*` rejected when REPO FILES has colocated tests), empty-repoFiles degradation (roots plausible, nested suspicious), backslash normalization, and the batch-level splitter.
- `server/src/swarm/blackboard/BlackboardRunner.ts`:
  - `runFirstPassContract` — after `parseFirstPassContract`, each criterion's `expectedFiles` is run through `classifyExpectedFiles`. Stripped paths post a per-path finding ("Contract c{N}: stripped suspicious path '...' (not in REPO FILE LIST and parent directory '...' not present). Unit 5d linked-commit fallback will rebind from later commits."). When any paths were stripped for a criterion, a system note summarizes the kept-vs-stripped ratio. A new `groundedContract: ParsedContract` is built from the filtered criteria and passed to `buildContract` — crucially, criteria keep their position (no c1/c2/c3 renumbering); if every path is stripped the criterion survives with `expectedFiles: []` and Unit 5d's linked-commit fallback handles the rebind.
  - `runPlanner` — same treatment on each todo. Since the planner schema requires `expectedFiles.min(1)`, a todo that loses *every* path has to be dropped entirely (leaving it with `[]` would fail Board CAS later). A per-todo finding is posted for the drop, and a single aggregate system note summarizes total stripped paths + dropped todos. If grounding empties the todo list completely, runPlanner short-circuits with the same "only invalid todos" posture it already had for schema-rejected todos.
- `server/package.json` — `scripts.test` gained `src/swarm/blackboard/prompts/pathValidation.test.ts` in the explicit file list. (The runner uses a hand-maintained list, not a glob; tests added to the tree without being listed here silently don't run.)

**Why enforcement at the runner, not the parser.** The parsers (`planner.ts`,
`firstPassContract.ts`) are pure schema validators with no repo knowledge;
injecting `repoFiles` into them would mean every test fixture has to pass a
file list. The runner already holds `seed.repoFiles` and is the natural
enforcement point. This also keeps the findings log legible: every strip posts
through `board.postFinding`, same channel the auditor uses, so the transcript
tells the honest story of what the planner tried vs. what the runner accepted.

**Verified.** `tsc --noEmit` clean; 345/345 server tests green (330 before
+ 15 Unit 6b pathValidation). No integration tests added for the runner
wiring — those are the job of the upcoming v10 E2E run (planned right after
commit).

---

## Unit 7 — Bound undici headersTimeout + surface retry state to the UI  **[committed: `9a04399`]**

During the v10 E2E run (`runs/phase11c-medium-v10/`), `agent-2` stalled mid-round
on `fetch failed <- Headers Timeout Error [UND_ERR_HEADERS_TIMEOUT]`. Node's
built-in fetch uses undici's default `Agent`, which sets `headersTimeout` to
~5 minutes. Combined with `retry.ts`'s three attempts (initial + two backoffs of
4s and 16s), a single stuck upstream could park an agent for ~15 minutes before
the retry chain finally gave up — during which the UI showed "thinking", giving
no indication the agent was in a degraded state. This unit addresses both
halves: tighten the network timeout to fail fast, and surface the retry state
to the panel so the user can see what's happening.

- `server/src/services/httpDispatcher.ts` — new module. Exports
  `HEADERS_TIMEOUT_MS = 90_000` and a `configureHttpDispatcher()` that calls
  `setGlobalDispatcher(new Agent({ headersTimeout: 90_000, bodyTimeout: 0 }))`
  once (guarded by an `installed` flag so repeated calls are no-ops).
  `bodyTimeout: 0` disables the stream-read timer explicitly — SSE event
  subscriptions stay open indefinitely, so a non-zero body timeout would tear
  down long-lived streams mid-run. 90s for headers gives the upstream more than
  enough time for cold-start variance without letting a jammed socket burn a
  full retry budget.
- `server/src/index.ts` — imports `configureHttpDispatcher` and invokes it at
  the top of the module, *before* the `AgentManager` import. This matters:
  `AgentManager` constructs SDK clients at spawn time, which eagerly builds
  fetch state; installing the dispatcher after that would leave those clients
  pinned to undici's default. The call has to run in the module-loading phase,
  not inside an async bootstrap.
- `server/src/types.ts` and `web/src/types.ts` — `AgentStatus` gains a
  `"retrying"` variant, and `AgentState` gains optional `retryAttempt`,
  `retryMax`, `retryReason`. The two files mirror each other by hand (no shared
  package), same pattern as the other parallel-edited DTOs.
- `server/src/swarm/blackboard/BlackboardRunner.ts` — in `promptAgent`'s catch
  block, before calling `interruptibleSleep(backoff)`, the agent now transitions
  into `"retrying"` with `{retryAttempt, retryMax, retryReason: shortMsg}` via
  both `manager.markStatus` (authoritative in-memory state) and
  `emitAgentState` (WS broadcast). The retry loop was already doing the sleep;
  this just makes the window visible.
- `web/src/components/AgentPanel.tsx` — amber-pulsing dot for `retrying`, and
  when `status === "retrying"` the status line reads
  `retrying 2/3 · UND_ERR_HEADERS_TIMEOUT` instead of the generic phase name.
  Falls back to `agent.status` when retry metadata is absent (covers the brief
  window between attempts when state has been reset but error has not).

**Why 90s and not 60s or 120s.** Observed v10 behavior: the stuck agent was
waiting on a first-token response after prompt submission, not mid-stream.
Ollama `glm-5.1:cloud` healthy first-token latency is typically 5-30s, with
occasional 60s+ outliers during model warm-up or queue contention on the cloud
side. 90s sits above the warm-up tail but well below undici's 5-minute default,
so genuine slowness retries while an actually-stuck socket fails fast and lets
the retry chain cycle through in ~20s of sleeps + three fast header timeouts
instead of 15 minutes of blocking.

**Why not tune `retry.ts` too.** The retry count and backoff curve are fine
once the timeout is bounded — the pathological budget was almost entirely
`attempts × headersTimeout`, not the backoff itself. Leaving `retry.ts`
untouched also means existing tests (which mock timings explicitly) don't need
to re-baseline.

**Verified.** `tsc --noEmit` clean in both `server/` and `web/`; 345/345 server
tests green (no new tests — the behavior is integration-level and exercised by
the next E2E run). No changes to test fixtures needed since the dispatcher
install is a no-op outside the server's Node process.

---

## Unit 8 — Role differentiation as a selectable preset  **[committed: `9a36e0d`]**

First preset past blackboard. The UI already had a greyed-out "Role
differentiation" option (`role-diff`); this unit backs it with a live
implementation so users can pick it from the Start-a-swarm form. No new
architectural piece — it rides on `RoundRobinRunner` via an optional
`roles` constructor arg.

- `server/src/swarm/roles.ts` — new pure module. Exports
  `DEFAULT_ROLES` (seven roles from `docs/swarm-patterns.md` §1: Architect,
  Tester, Security reviewer, Performance critic, Docs reader, Dependency
  auditor, Devil's advocate) and `roleForAgent(agentIndex, roles)` which does
  1-based modulo so agent 8 wraps back to role 0. Throws on bad inputs so a
  miswired preset crashes at `buildPrompt` time rather than silently producing
  generic output.
- `server/src/swarm/roles.test.ts` — 8 tests across 2 describe blocks:
  catalog shape (exactly 7 named roles, non-empty guidance), `roleForAgent`
  sequential + wrap-around + invalid-input + custom-table.
- `server/src/swarm/RoundRobinRunner.ts` — constructor takes an optional
  second argument `{ roles?: readonly SwarmRole[] }`. When present,
  `buildPrompt` prepends a role line (`Your role is "Tester"`) and a
  guidance paragraph, and labels transcript lines as
  `[Agent 2 (Tester)] ...` so peer @mentions and re-reads stay legible.
  When absent, the prompt and transcript format are bit-for-bit identical
  to the pre-Unit-8 output — plain `round-robin` keeps its exact behavior.
- `server/src/services/Orchestrator.ts` — `buildRunner` gains a
  `"role-diff"` case that instantiates `RoundRobinRunner` with
  `DEFAULT_ROLES`. The exhaustiveness check on `PresetId` is preserved.
- `server/src/swarm/SwarmRunner.ts` — `PresetId` gets a third member
  `"role-diff"`.
- `server/src/routes/swarm.ts` — the Zod enum on the start endpoint
  accepts `"role-diff"` alongside the existing two.
- `server/package.json` — `scripts.test` gains `src/swarm/roles.test.ts`.
  (The runner's file list is hand-maintained; tests not listed there silently
  don't run.)
- `web/src/components/SetupForm.tsx` — the existing `role-diff` PRESETS
  entry flipped from `status: "planned"` to `status: "active"`, which
  enables the Start button when selected. No new form fields — role count
  and role catalog are fixed in v1.
- `docs/swarm-patterns.md` — flipped §1 status marker from `[ ]` to `[x]`
  and updated the implementation-roadmap row.

**Why reuse `RoundRobinRunner` instead of a new class.** The role catalog
changes ~15 lines of prompt text; everything else (seeding, transcript
management, the 20-minute absolute turn cap, error surfacing) is identical
to plain round-robin. A subclass or separate runner would duplicate 250+
lines for negligible gain. Keeping `role-diff` as a configured variant of
round-robin also means any future round-robin fix (e.g. a new watchdog
behavior) applies to both presets automatically.

**Why keep plain `round-robin` alive.** It's the no-role baseline for A/B
comparisons. Without it we can't tell whether a behavior difference in a
run is from role priors or from general round-robin dynamics.

**Role catalog source.** `docs/swarm-patterns.md` §1 names all seven. The
guidance strings are new; each leans on the role's actual responsibility
(e.g. Security reviewer: "Cite the specific line or dependency. If you see
nothing to flag, say so — don't invent threats.") to push back against the
generic-agent drift that plain round-robin suffers from.

**Verified.** `tsc --noEmit` clean in both `server/` and `web/`; 353/353
server tests green (345 before + 8 Unit 8 roles). End-to-end validation is
the job of the next run — pick `role-diff` on the setup form and confirm
the transcript shows seven distinguishable voices.

---

## Unit 9 — Process-tree kill on Windows shutdown  **[committed: `880b185`]**

Close the opencode-grandchild leak the user hit after Ctrl+C'ing
`npm run dev`: `kill-port 52072 55090…` actually found live PIDs each
time, which means shutdown wasn't cleaning up.

**Root cause chain.** On Windows `child.kill("SIGTERM")` is a direct
`TerminateProcess` — the target dies immediately without its own
handlers running. So when `dev.mjs`'s SIGINT handler SIGTERMs the
backend, the backend's `process.on("SIGINT")` handler in
`server/src/index.ts` never gets a chance to call `orchestrator.stop()`
→ `AgentManager.killAll()`. The opencode servers spawned by
`AgentManager.spawnAgent` (with `shell: true` on Windows, i.e. wrapped
in `cmd.exe /d /s /c`) are orphaned. Compounding this, `child.kill()`
of a shell-wrapped spawn only terminates the `cmd.exe`; the real
`opencode.exe` grandchild survives and keeps holding its port.

**Fix.** `taskkill /PID <pid> /T /F` — `/T` walks the process tree,
`/F` force-terminates. Applied at every shutdown call site:

- `server/src/services/treeKill.ts` — new helper. On win32 spawns
  `taskkill`; on POSIX falls back to `child.kill("SIGTERM")` because
  Node's signal forwarding is already reliable there. Guards against
  `undefined`, missing pid, already-killed, and already-exited children
  so repeated calls are idempotent.
- `server/src/services/treeKill.test.ts` — 5 guard-clause tests.
  Doesn't exercise the `spawn("taskkill", …)` path — mocking child
  processes cross-platform is fragile and the pid-gating guards are
  the parts a refactor can actually regress.
- `server/src/services/AgentManager.ts` — replaces `child?.kill()` in
  the `spawnAgent` catch (cleanup for a spawn that failed mid-init) and
  `a.child?.kill()` inside `killAll` with `treeKill(…)`. The
  `client.session.abort` call in `killAll` stays — it's the graceful
  close that fires first; `treeKill` is what kills the process that
  session was running under.
- `scripts/dev.mjs` — same helper inlined (different module system, no
  shared build setup). Replaces both `child.kill("SIGTERM")` in
  `shutdown()` and the 4-second `child.kill("SIGKILL")` escalation.
  On Windows `taskkill /F` is already the hardest kill, so the "try
  again after 4s" timeout re-issues `taskkill` in case the first call
  couldn't find the tree (e.g. a child that spawned grandchildren only
  after we had already enumerated it).
- `server/package.json` — `scripts.test` gains
  `src/services/treeKill.test.ts`.

**Why inline `treeKill` in `dev.mjs` instead of sharing.** `dev.mjs` is
a standalone ESM script outside the `server/` workspace; it has no
`tsx`/TypeScript compile step and can't import from `server/src/`. A
shared package for a 20-line helper would be overkill. The two copies
are the same 20 lines — if one gets fixed, the other gets the same
diff by eye.

**POSIX behavior unchanged.** `process.platform === "win32"` is the only
branch that calls `taskkill`; everywhere else the old `child.kill(signal)`
path runs as before. The two Linux/macOS users on this repo (counting
the WSL CI path) shouldn't see any difference.

**Verified.** `tsc --noEmit` clean in both `server/` and `web/`; 358/358
server tests green (353 before + 5 Unit 9 guard tests). End-to-end
validation is a manual PowerShell smoke test on Windows:
`npm run dev` → start a swarm in the UI so workers spawn → Ctrl+C →
`kill-port <port>` on each previously-spawned port. If Unit 9 worked,
every `kill-port` reports "no process found on port X". If it didn't,
same symptoms as before and we'd need to dig into whether `taskkill` is
being reached at all.

---

## Unit 10 — Council preset (parallel drafts + reconcile)  **[committed: `2395ef9`]**

Direct answer to the single-planner weakness observed on the MatSci
Explorer run: a preset where no one agent defines the goal. Every agent
produces an independent first draft with zero visibility of peers, then
all drafts are revealed and agents revise across subsequent rounds.

**Why this preset now, before orchestrator-worker or debate-judge.**
Council is architecturally the lightest of the three not-yet-shipped
patterns user named — it's a round-based runner like role-diff, no file
edits, no heterogeneous models, no fixed yes/no framing. It rides on
the same transcript/spawn/seed machinery we already have and introduces
exactly one new mechanic: *within a round, don't let agent A see agent
B's output yet*. That single mechanic is the whole value — it breaks
the echo-chamber pattern that round-robin and role-diff both inherit
from sharing a running transcript.

- `server/src/swarm/CouncilRunner.ts` — new runner implementing
  `SwarmRunner`. Structurally similar to `RoundRobinRunner` (shared
  `seed`, `status`, `injectUser`, `stop`, `setPhase`, `emitAgentState`
  shapes) but with two meaningful differences:
  1. `loop()` fans out agent turns via `Promise.allSettled` instead
     of a serial `for` loop. All agents in a round run concurrently.
  2. Before the round fires, `loop()` captures a `snapshot` of the
     transcript. Every `runTurn` in the round builds its prompt from
     that snapshot, not from the live `this.transcript`. Even if
     agent-1's `session.prompt` returns and appends while agent-3 is
     still waiting, agent-3's prompt was already committed at
     snapshot time — it sees nothing new. This is the enforcement
     point for Round 1 independence.
  `extractText` and `describeSdkError` are duplicated from
  `RoundRobinRunner` rather than shared — extracting a tiny shared
  module for two callers would be premature. Re-evaluate when a
  third runner wants them.
- `buildCouncilPrompt(agentIndex, round, totalRounds, snapshot)` —
  exported pure function. When `round === 1`, filters out every
  `role === "agent"` entry from the visible transcript, so the
  per-agent round-1 prompt contains only system + user (the seed and
  any human-injected messages). When `round > 1`, the full transcript
  is visible including peer drafts. Header text is round-aware:
  round-1 says *"your independent first draft … you cannot see the
  other agents' drafts; that is deliberate."*; round-2+ says *"the
  other agents' prior drafts are in the transcript … revise your own
  position."*
- `server/src/swarm/CouncilRunner.test.ts` — 9 tests across 3 describe
  blocks. Round-1 independence: peer-agent content absent from prompt
  body; `[Agent N]` transcript lines don't appear for peers; system
  + user entries still visible; draft-round wording present; empty
  transcript handled. Round-2+ reveal: peer drafts present; revision
  wording; round 3 still reveals. General shape: requesting agent
  named in header + closing line; discussion goals listed.
- `server/src/swarm/SwarmRunner.ts` — `PresetId` gains `"council"`.
- `server/src/services/Orchestrator.ts` — `buildRunner` gains a
  `case "council": return new CouncilRunner(this.opts)`. Exhaustiveness
  check preserved.
- `server/src/routes/swarm.ts` — Zod enum on the start endpoint
  accepts `"council"`.
- `server/package.json` — test script registers
  `src/swarm/CouncilRunner.test.ts`.
- `web/src/components/SetupForm.tsx` — existing `council` PRESETS entry
  flipped from `status: "planned"` to `status: "active"`. Summary
  updated from *"Round 2 reconcile or vote"* (never true) to *"Round
  2+ reveal and revise"* (what we actually shipped). No reconcile
  policy in v1.
- `docs/swarm-patterns.md` — §3 flipped `[ ]` → `[x]`; roadmap row
  updated; body expanded with the snapshot-based enforcement note.

**What Council does NOT do in v1.**
- **No explicit reconcile step.** No vote, no synthesizer, no judge.
  The user reads the final round's drafts and reconciles in their
  head. An automatic reconcile would be a Unit 11+ add if it earns
  its keep on observed runs.
- **No retry wrapper.** Same limitation as
  `RoundRobinRunner.runTurn` (see `docs/known-limitations.md`).
  `UND_ERR_HEADERS_TIMEOUT` on any agent in any round kills that
  agent's draft for that round — the others continue.
- **No convergence detection.** Runs the full configured `rounds`
  count always. Would need a diff-based "nobody changed their
  position" check to early-terminate.

**Why Promise.allSettled, not Promise.all.** One agent's failure must
not cancel in-flight prompts for its peers. Promise.all rejects on
first failure, which would abort the whole round; allSettled lets the
survivors finish and land their drafts.

**Verified.** `tsc --noEmit` clean in both `server/` and `web/`; 367/367
server tests green (358 before + 9 Unit 10 prompt-shape tests). E2E
validation: pick Council on the setup form, run against any small repo,
check that Round-1 drafts show meaningfully different takes (no
copy-paste convergence — that's the echo chamber Council exists to
prevent).

---

## Unit 11 — Blackboard honors `rounds` + auditor stops surrendering on first try  **[committed: `ed06ff0`]**

User-reported bug, logged here because it's a real behavior change:
the setup form's **Rounds** slider was cosmetic for blackboard mode.
A run with `rounds: 6` produced the same single plan-audit cycle as
`rounds: 1`. Worse, on the 2026-04-22 MatSci Explorer run the auditor
short-circuited the loop by stamping four of six criteria as
`wont-do` ("No test files exist and the repo file list does not
include…") on invocation 1 — so even if the loop *could* have run
longer, it exited after 1 cycle because `wont-do` counts as resolved.
Two bugs stacked: the knob was dead AND the auditor surrendered on
first sight of missing files.

**Change 1: `rounds` now drives the auditor invocation cap in blackboard.**

- `server/src/swarm/blackboard/BlackboardRunner.ts` — the hardcoded
  `AUDITOR_MAX_INVOCATIONS = 5` constant is gone. Its four usage sites
  (cap check, stop detail, progress label, auditor seed's
  `maxInvocations` field) now read from a private `maxAuditInvocations`
  getter that returns `this.active?.rounds ?? 5`. The zod schema on the
  start endpoint already validated `rounds` to `[1, 10]`, so the cap is
  always sensibly bounded.
- Stop-detail message, when the cap trips, now suggests raising
  "Rounds" on the setup form so users know the knob exists and what it
  controls.
- `README.md` — item 5 ("Rounds") rewritten. The old sentence
  *"Ignored by the blackboard preset, which terminates on hard caps
  instead"* was accurate pre-Unit-11; post-Unit-11 blackboard uses
  `rounds` as the plan→work→audit cycle cap (hard caps still apply on
  top).

**Change 2: auditor prompt forbids `wont-do` when no work has been attempted.**

- `server/src/swarm/blackboard/prompts/auditor.ts` — decision-process
  steps 4 and 5 rewritten and HARD RULE 7 rewritten. The tightening:
  - Step 4 now explicitly says *"Workers CAN create new files from
    nothing — 'the file does not exist yet' is NOT a reason to verdict
    `wont-do`. Emit a todo that creates the file."*
  - Step 5 redefines `wont-do` as requiring **both** (a) the criterion
    inherently needs shell execution per Rule 8, AND (b) further file
    edits are unlikely to help. Missing work is now unambiguously
    `unmet`, not `wont-do`.
  - Rule 7 used to say *"Prefer wont-do with a clear rationale over
    infinite unmet loops."* That was fine in theory but in practice
    licensed the MatSci failure mode. Rewrite: *"A criterion with
    ZERO attempted todos (no `committed`, no `skipped`) is NEVER
    `wont-do` unless Rule 8 applies. First-invocation hesitance is
    the problem this rule exists to prevent."* Rule 8 (shell-execution
    → wont-do) is left intact — that's the legitimate use case.
- `server/src/swarm/blackboard/prompts/auditor.test.ts` — new test
  locking in the "zero attempted todos → never wont-do" language and
  the "workers CAN create new files" affordance. If a future refactor
  weakens either, the test fails.

**Why fix Change 1 and Change 2 together.** Fixing only the cap is
useless — more allowed cycles don't help if the auditor still exits
on invocation 1 by calling everything `wont-do`. Fixing only the
prompt tightens auditor behavior but leaves `rounds` dead. Both
changes together give the user a knob that actually drives depth:
raise `rounds` → more cycles available → auditor now willing to ask
the planner to try → planner emits todos for previously-surrendered
criteria → workers attempt them → next audit judges the result.

**Expected post-Unit-11 behavior on the MatSci-style repo.** Planner
writes 6 criteria (including three "unit tests for X" criteria).
Workers do the 2 easy ones (gitignore, requirements pinning). Auditor
invocation 1: the three test-file criteria are now `unmet` (not
`wont-do`) because no todo has ever attempted them — auditor emits a
todo for each. Cycle 2: workers attempt to write test files. Cycle 3:
auditor judges the attempts. If test files exist and look plausible,
`met`; if workers genuinely couldn't produce content (e.g., target
module is too opaque), `wont-do` becomes legitimate because attempts
exist. The `rounds` budget caps how many such cycles are permitted.

**What this does NOT change.**
- Hard caps (20 min wall-clock, 20 commits, 30 todos) are unchanged.
  A lazy planner on a tight deadline still terminates.
- Workers' loop, claim/commit mechanics, CAS, stale-replan — all
  untouched.
- The legitimate `wont-do` pathway for shell-execution criteria
  ("tests must pass via pytest") is preserved via Rule 8.
- Round-robin / role-diff / council: `rounds` still means "passes
  through the agents," unchanged.

**Verified.** `tsc --noEmit` clean in both `server/` and `web/`;
368/368 server tests green (367 before + 1 Unit 11 prompt-tightening
test). E2E validation: re-run the MatSci Explorer scenario with
`rounds: 6` and watch for 3+ auditor invocations instead of 1, with
test-file criteria cycling through `unmet → committed → met` rather
than flipping to `wont-do` on first sight.

**E2E confirmed 2026-04-22 on `kevinkicho/kmatsci040226`:** run went
from 1 commit / 0 test files / 4 bogus wont-dos (pre-Unit-11) → 5
commits / 3 real test files + CI workflow / 1 legit wont-do. Ended on
`cap:wall-clock` with the auditor still emitting repair todos — the
cap caught the tail, not a regression. See
`runs/kmatsci-demo-unit11/kmatsci040226/summary.json`.

---

## Unit 12 — Orchestrator–worker preset  **[committed: `4fe0a13`]**

Third of the four presets the user asked for in this session (after
Council in Unit 10; debate-judge, map-reduce, stigmergy still to come).
The name matches Anthropic's own multi-agent research pattern:
Agent 1 is the LEAD (reads repo, produces a plan, synthesizes results),
agents 2..N are WORKERS (each executes one subtask in parallel, with
NO peer visibility).

**Mechanic.** Per cycle:

1. **Plan.** Lead sees the full transcript and emits a JSON object:
   `{"assignments": [{"agentIndex": 2, "subtask": "…"}, …]}`. One
   assignment per worker, lead can't self-assign.
2. **Execute.** Workers fan out via `Promise.allSettled`. Each worker's
   prompt contains ONLY its assigned subtask + the seed system messages
   — no transcript, no peer reports, not even the lead's planning
   output. That isolation is the point: workers produce independent,
   parallel, directed coverage.
3. **Synthesize.** Lead sees the full transcript again (now including
   all worker reports from this cycle) and writes a synthesis: what
   the project is, what's working, what's missing, one concrete next
   action, citing workers by index.

`rounds` = number of plan→execute→synthesize cycles. Between cycles
the lead can refine based on prior syntheses visible in the transcript.

- `server/src/swarm/OrchestratorWorkerRunner.ts` — new runner
  implementing `SwarmRunner`. Enforces `agentCount >= 2` at start
  (can't have a lead with no workers). Min on `SetupForm` is 2.
- `parsePlan(raw, allowedWorkerIndices)` — exported pure function.
  Accepts clean JSON, markdown-fenced JSON, or JSON embedded in prose
  (takes the first `{...}` block). Drops assignments whose
  `agentIndex` isn't in the worker set (prevents self-assignment to
  the lead and to non-spawned workers), drops duplicates (keeps
  first), drops empty subtasks. Malformed input returns an empty
  plan — the runner then skips the execute phase for that cycle with
  a system-message explaining why, preserving the raw lead output in
  the transcript for debugging.
- `buildLeadPlanPrompt` / `buildWorkerPrompt` / `buildLeadSynthesisPrompt`
  — three exported pure prompt builders, each covered by tests. The
  worker prompt builder is the independence enforcement point: it's
  given only `(workerIndex, round, totalRounds, subtask,
  seedSnapshot)` — it literally cannot leak peer content because it
  doesn't receive peer content.
- `server/src/swarm/OrchestratorWorkerRunner.test.ts` — 19 tests
  across 5 describe blocks. `parsePlan` happy path + guards (fence
  stripping, prose-embedded JSON, lead self-assignment rejection,
  duplicate dropping, empty-subtask dropping, unparseable input,
  non-array assignments). Prompt builders: worker prompt contains
  only subtask + seed (not peer content); lead plan prompt names
  all workers + forbids assigning to lead; cycle 1 gets broad-coverage
  hint vs later cycles get refinement hint; synthesis prompt includes
  worker reports + asks for next action + gap-for-next-cycle (mid-run)
  vs final-recommendation (last cycle).
- `server/src/swarm/SwarmRunner.ts` — `PresetId` gains `"orchestrator-worker"`.
- `server/src/services/Orchestrator.ts` — `buildRunner` case.
- `server/src/routes/swarm.ts` — Zod enum accepts `"orchestrator-worker"`.
- `server/package.json` — registers the new test file.
- `web/src/components/SetupForm.tsx` — flipped `status: "planned"` →
  `"active"`. Summary text updated. `min` lowered from 3 to 2 (lead +
  1 worker is the minimum viable configuration).
- `docs/swarm-patterns.md` — §4 flipped `[ ]` → `[x]`; roadmap row
  updated; body expanded with the v1-scope note about model
  heterogeneity being deferred.

**What Orchestrator–worker does NOT do in v1.**
- **No model heterogeneity.** Lead and workers all use `cfg.model`.
  The canonical "stronger planner + cheaper workers" split (Opus →
  Sonnet/Haiku in Anthropic's research system) would need a
  `LEAD_MODEL` env var + `workerModel` / `leadModel` separation in
  `RunConfig`. Orthogonal to the preset shape; defer until we
  actually run the same repo through this preset on two model sizes
  and see what that comparison tells us.
- **No retry wrapper.** Same limitation as Council and
  `RoundRobinRunner` (see `docs/known-limitations.md`). A timed-out
  worker loses its cycle's report; the lead's synthesis continues
  with whatever came back.
- **No plan validation against repo reality.** The lead can emit
  "inspect src/tests/" even if `src/tests/` doesn't exist; the
  worker's attempt will produce a wasted report. The blackboard
  preset's Unit 6a/6b path-grounding could be ported here if it
  becomes an issue — not urgent.

**Why reuse the same prompt/turn mechanics instead of something new.**
The `runAgent` helper is a near-copy of `runTurn` from
`RoundRobinRunner`/`CouncilRunner`. Abstracting over them is tempting
but premature: the three runners differ in *when* they call
`runAgent` (serial per round / parallel within round / split by
role), and that's where their value is. Extraction waits for a 4th
caller; today the duplicated ~40 lines of "start watchdog, call
session.prompt, append transcript, mark status" is the right call.

**Verified.** `tsc --noEmit` clean in both `server/` and `web/`;
387/387 server tests green (368 before + 19 Unit 12). E2E validation:
pick Orchestrator–worker on the setup form with agentCount 4, watch
for a plan JSON from agent-1 followed by three parallel `thinking`
workers followed by a synthesis from agent-1.

---

## Unit 13 — Debate + judge preset  **[committed: `000c38e`]**

Fourth preset of this session. Fixed 3 agents, yes/no framing:

- **Agent 1 = PRO** — argues FOR the proposition.
- **Agent 2 = CON** — argues AGAINST.
- **Agent 3 = JUDGE** — silent until the final round, then reads the
  whole debate and delivers a verdict: `PRO WINS` / `CON WINS` / `TIE`
  plus confidence `LOW` / `MEDIUM` / `HIGH`.

Per round, Pro goes first, then Con. Both see the running transcript
so they can rebut each other specifically (unlike Council's round-1
isolation — here the whole point is direct argumentation, so visibility
is on). The Judge stays quiet until the final round runs, then goes
last with the full debate in front of it.

**Proposition override.** The proposition defaults to *"This project is
ready for production use."*. Users override by using the setup form's
inject-message field *before starting the run* — the most recent
pre-start user injection is picked up as the proposition for this run.
Once the run is underway, injectUser posts to the transcript as
ordinary commentary (does not re-set the proposition mid-debate —
changing the proposition after arguments started would be nonsense).

- `server/src/swarm/DebateJudgeRunner.ts` — new runner. Enforces
  exactly 3 agents at start (the Zod schema + SetupForm's `min=max=3`
  also enforce this, but we check again here so a direct-API caller
  gets a clear error instead of a downstream "no judge" crash). The
  runner's loop per round is: `runDebaterTurn(pro)` →
  `runDebaterTurn(con)` → (if final round) `runJudgeTurn(judge)`.
  Transcript entries from agent-1 and agent-2 are relabeled as `[PRO]`
  / `[CON]` for readability when building later prompts.
- `buildDebaterPrompt({side, round, totalRounds, proposition,
  isFinalRound, transcript})` — exported pure function. Side-specific
  role text (`PRO (arguing FOR)` vs `CON (arguing AGAINST)`),
  round-aware brief (mid-debate rounds say "rebut your opponent
  specifically"; final round says "make your closing statement"),
  hard rule forbidding side-flipping or conceding.
- `buildJudgePrompt({proposition, transcript})` — exported pure
  function. Asks for (1) one-paragraph summary of each side's
  strongest arg, (2) weakest points of each side, (3) verdict with
  which specific argument tipped it, (4) confidence. Instructs judge
  to score **on the merits of arguments presented**, not on prior
  opinion of the proposition — so a weaker argument for the "correct"
  side can lose to a stronger argument for the "wrong" side.
- `DEFAULT_PROPOSITION` exported constant, covered by a test
  asserting it's non-empty.
- `server/src/swarm/DebateJudgeRunner.test.ts` — 12 tests across
  5 describe blocks. Side-specific framing (PRO names agent-1 +
  argues FOR, CON names agent-2 + argues AGAINST, hard rule against
  side-flipping is present). Round-aware framing (mid-debate
  "rebut specifically", final-round "closing statement"). Transcript
  visibility (peers labeled PRO/CON not Agent 1/2, empty transcript
  handled). Judge (identifies agent-3, demands explicit verdict
  shape, merits-not-prior-beliefs instruction, transcript renders as
  PRO/CON).
- `server/src/swarm/SwarmRunner.ts` — `PresetId` gains `"debate-judge"`.
- `server/src/services/Orchestrator.ts` — `buildRunner` case.
- `server/src/routes/swarm.ts` — Zod enum accepts `"debate-judge"`.
- `server/package.json` — registers the new test file.
- `web/src/components/SetupForm.tsx` — flipped `status: "planned"` →
  `"active"`. Summary text updated to spell out PRO vs CON vs JUDGE
  and "Fixed 3 agents". `min=max=3` unchanged.
- `docs/swarm-patterns.md` — §5 flipped `[ ]` → `[x]`; roadmap row
  updated.

**What Debate + judge does NOT do in v1.**
- **No proposition UI field.** The inject-message-before-start
  mechanic works but is quirky. If the pattern gets real use, a
  dedicated "Proposition" input would be cleaner. Deferred until we
  see it actually get picked from the dropdown.
- **No judge scoring rubric.** The judge's verdict is free-text;
  we extract `PRO WINS` / `CON WINS` / `TIE` by eye. If we wanted a
  `summary.json`-style artifact with `{verdict: "PRO", confidence:
  "HIGH"}` we'd need a JSON-parsed judge output. Not urgent — the
  prose verdict is the interesting part.
- **Same retry-wrapper limitation.** A timed-out debater kills its
  turn for that round; the debate continues with the silent half.

**Verified.** `tsc --noEmit` clean in both `server/` and `web/`;
399/399 server tests green (387 before + 12 Unit 13). E2E validation:
pick Debate + judge on the setup form (agentCount locks to 3), set
rounds ≥ 2, optionally inject a custom proposition before hitting
Start, then watch for agent-1 and agent-2 exchanges followed by an
agent-3 verdict on the final round.

---

## Unit 14 — Map-reduce preset  **[committed: `4ce56d0`]**

Fifth preset of this session. Direct counterpoint to the
LLM-planner-laziness failure mode that Unit 11 fixed downstream of —
*here* we side-step it entirely by using a **mechanical** partition
of the repo, not an LLM-decided one.

**Roles.** Agent 1 = REDUCER (silent during the map phase, then
synthesizes). Agents 2..N = MAPPERS, each gets a fixed slice of the
top-level repo entries.

**Mechanic.** At start, the runner calls `RepoService.listTopLevel`
and runs `sliceRoundRobin(entries, mapperCount)` to partition. Then
per cycle:

1. **Map.** All mappers fire in parallel via `Promise.allSettled`.
   Each mapper's prompt names its assigned slice and the seed; it
   does NOT see the transcript, peer reports, or even the reducer's
   prior synthesis. The mapper is told explicitly: *"Inspect ONLY
   the entries in your slice. Do NOT speculate about entries outside
   your slice."*
2. **Reduce.** Reducer sees the full transcript (all mapper reports
   from this cycle, plus prior cycles' syntheses) and writes a
   synthesis labeled with `[Mapper N]` references for every claim.

`rounds` = number of map-reduce cycles. Cycle 1 = broad coverage;
cycle 2+ has the reducer ask for a coverage gap or final picture.
Slices stay constant across cycles in v1 (no re-slicing based on
gap analysis — that's a future extension if it earns its keep).

- `server/src/swarm/MapReduceRunner.ts` — new runner. Enforces
  `agentCount >= 3` (reducer + at least 2 mappers; with only 1
  mapper, map-reduce reduces to "one agent reads, one agent
  summarizes," which is just a 2-step round-robin and not worth the
  preset surface). The `SetupForm`'s `min: 3` already enforces
  this client-side; the runtime check guards against direct API
  callers.
- `sliceRoundRobin(entries, k)` — exported pure function.
  Round-robin partition: every entry goes to exactly one slice,
  slice lengths differ by at most 1. Skips `.git`, `node_modules`,
  `.DS_Store` (filtered before slicing — those entries don't
  contribute to understanding). Tests cover the partition invariant
  on a real-shaped repo entry list.
- `buildMapperPrompt(mapperIndex, round, totalRounds, slice,
  seedSnapshot)` — exported pure function. The isolation enforcement
  point: the prompt receives only the assigned slice + seed, never
  peer content. Hard rule: "Do NOT speculate about entries outside
  your slice." Tests verify peer slice content (e.g. `tests/`,
  `docs/`) is absent from a mapper assigned `[src/, package.json]`.
- `buildReducerPrompt(round, totalRounds, transcript)` — exported
  pure function. Asks for project description / what works / what's
  missing / (mid-cycle) coverage gap to hit next, OR (final cycle)
  unified picture + single most important next step. Hard rule
  forbids inventing evidence beyond mapper reports — the reducer's
  job is consolidation, not new claims.
- `server/src/swarm/MapReduceRunner.test.ts` — 15 tests across 3
  describe blocks. `sliceRoundRobin` partition shape (even, uneven,
  partition invariant, more slices than entries, k<=0, empty input);
  mapper prompt isolation (no peer slice leakage, no-speculation
  rule, mapper named in header+closing, "cannot see peers — by
  design" wording, empty slice handled); reducer prompt (mapper
  reports labeled `[Mapper N]`, mid-run gap-asking, last-cycle final
  picture, no-invented-evidence rule).
- `server/src/swarm/SwarmRunner.ts` — `PresetId` gains `"map-reduce"`.
- `server/src/services/Orchestrator.ts` — `buildRunner` case.
- `server/src/routes/swarm.ts` — Zod enum accepts `"map-reduce"`.
- `server/package.json` — registers the new test file.
- `web/src/components/SetupForm.tsx` — flipped `status: "planned"` →
  `"active"`. Summary text updated to spell out round-robin slicing
  + isolation. `min=3` unchanged.
- `docs/swarm-patterns.md` — §2 flipped `[ ]` → `[x]`; roadmap row
  updated; body expanded with the rationale for mechanical (not
  LLM-decided) slicing.

**Why ship slicing as round-robin instead of by-folder semantics.**
Round-robin is dumb-simple, deterministic, and produces no surprises
when the repo's top-level shape is awkward (one giant `src/` and a
README). A "smart" by-folder slicer (e.g., split `src/` into
sub-directories when it's much bigger than other entries) is a
reasonable v2 — but the v1 question we want answered is "does
isolation beat shared context for coverage?" and the cleaner
experiment uses the simpler partition.

**What this does NOT do in v1.**
- **No re-slicing between cycles.** Cycle 2's mappers get the same
  slices as cycle 1. The intended use is "deepen the same area" or
  "verify on a re-read"; "go fix this gap the reducer found" needs
  a re-slicer.
- **No retry wrapper.** Same as Council/OrchestratorWorker. A
  timed-out mapper loses its slice's report for the cycle; the
  reducer has to work with what survived.
- **Coarse slice unit.** Top-level entries only. A 50-file
  `src/` dir all goes to one mapper. If the slice is big, that
  mapper's prompt is small (slice = list of names) but its
  inspection time grows.

**Verified.** `tsc --noEmit` clean in both `server/` and `web/`;
414/414 server tests green (399 before + 15 Unit 14). E2E validation:
pick Map-reduce on the setup form with agentCount 5 (reducer + 4
mappers), watch for the seed system message announcing the slicing,
4 parallel `thinking` mappers, then a single reducer turn citing
mappers by index.

---

## Unit 15 — Stigmergy preset (standalone)  **[committed: pending]**

Sixth preset of this session, completing the user's list
(orchestrator-worker, debate-judge, map-reduce, stigmergy). No
planner, no role assignment — all agents are equal explorers.

**Design decision up front.** Stigmergy was described in
`docs/swarm-patterns.md` as *"Layer on blackboard"* — i.e., workers
on the existing blackboard preset consult a file-annotation table
when picking the next todo. That's the canonical formulation but it
requires surgery on `BlackboardRunner.claim`/`replan` internals,
which is both large and risky for a preset whose primary use is
exploration (not file editing). So Unit 15 ships stigmergy as a
**standalone preset for repo exploration**. The blackboard-layer
variant is deferred and explicitly noted as future work in
`docs/swarm-patterns.md` §8.

**Mechanic.** The runner keeps an in-memory `Map<filePath,
AnnotationState>` where `AnnotationState` is `{visits, avgInterest,
avgConfidence, latestNote}` — the shared "pheromone trail." Per
round, agents go in index order; each agent:

1. Sees the current annotation table (formatted as a sorted text
   block: most-visited first, alphabetical ties broken
   deterministically) plus the top-level candidate paths.
2. Picks ONE file to inspect — the prompt teaches the heuristic
   "untouched files are most attractive; among visited, prefer high
   INTEREST + low CONFIDENCE; avoid well-covered files." The model
   decides; the runner just exposes the signal.
3. Reads the file via tools, writes a prose report, and appends a
   single-line annotation JSON: `{"file": "...", "interest": 0-10,
   "confidence": 0-10, "note": "..."}`.
4. Runner parses the annotation, clamps interest/confidence to
   [0, 10] (so a model that returns `100` or `-5` can't poison the
   table), and merges via running average weighted equally per
   visit. If parse fails, a system message notes "no annotation
   update this turn" but keeps the agent's text in the transcript.

`rounds` = how many exploration passes through agents. Total turns =
`rounds × agentCount`. Min 2 agents — emergence needs multiple
participants.

- `server/src/swarm/StigmergyRunner.ts` — new runner. Enforces
  `agentCount >= 2`. On successful run completion, appends a final
  system message dumping the full formatted annotation table, so
  the transcript closes with the pheromone map of what was found
  where.
- `parseAnnotation(raw)` — exported pure function. Accepts clean
  JSON / markdown-fenced JSON / JSON embedded in prose (takes the
  first `{...}` block). Coerces `file` to trimmed string,
  `interest`/`confidence` to numbers clamped to [0, 10]; treats
  missing `note` as empty string (not a rejection). Returns null
  if the required `file`/`interest`/`confidence` keys are missing
  or malformed.
- `buildExplorerPrompt({agentIndex, round, totalRounds,
  candidatePaths, annotations})` — exported pure function. Renders
  the annotation table inline (via `formatAnnotations`), teaches
  the attractiveness rule explicitly, specifies the required JSON
  output shape. No peer transcript — each agent's prompt is the
  seed + annotation-table + candidate-paths, nothing more.
- `formatAnnotations(map)` — exported pure function. Sorts entries
  by visit count desc, alphabetical ties. Empty map renders as
  *"(empty — no files annotated yet; everything is untouched)"* so
  round-1 agents know they have free rein.
- `server/src/swarm/StigmergyRunner.test.ts` — 17 tests across 4
  describe blocks. `parseAnnotation` happy path (clean JSON, fenced,
  prose-embedded) + clamping & rejection (out-of-range clamps,
  missing/bad types, missing note = empty string, non-JSON input).
  `formatAnnotations` ordering (empty-state, visit-count then
  alphabetical). `buildExplorerPrompt` pheromone visibility (table
  rendered inline, empty-table message present, attractiveness rule
  present, JSON shape spec present, agent named in header+closing).
- `server/src/swarm/SwarmRunner.ts` — `PresetId` gains `"stigmergy"`.
- `server/src/services/Orchestrator.ts` — `buildRunner` case.
- `server/src/routes/swarm.ts` — Zod enum accepts `"stigmergy"`.
- `server/package.json` — registers the new test file.
- `web/src/components/SetupForm.tsx` — flipped `status: "planned"` →
  `"active"`. Summary text updated. `min` lowered from 3 to 2
  (emergence requires ≥2 agents).
- `docs/swarm-patterns.md` — §8 flipped `[ ]` → `[x]`; roadmap row
  updated to note the standalone vs blackboard-layer distinction.

**What Stigmergy does NOT do in v1.**
- **No re-visit cap.** An agent can legitimately pick a file that's
  already been visited — the heuristic says "prefer untouched, but
  among visited, target high-interest low-confidence." If all files
  are well-covered, agents will converge on re-reads. Acceptable
  for an exploration tool.
- **No annotation persistence.** The table is wiped on each
  `start()`. If we want cross-run continuity (e.g., "explore this
  repo across 3 sessions") we'd need to serialize to disk.
- **No explicit synthesizer.** The run ends with the annotation
  table dumped as a system message and every agent's prose reports
  in the transcript. There's no "final synthesis" turn. Users read
  the table and reports directly.
- **Coarse granularity.** Candidates are top-level repo entries.
  An agent *can* drill deeper via its file-read tool but the
  annotation it returns is against whatever path it picked — so
  annotations may be directory-level, not file-level, depending on
  how the agent interprets its pick.

**Verified.** `tsc --noEmit` clean in both `server/` and `web/`;
431/431 server tests green (414 before + 17 Unit 15). E2E validation:
pick Stigmergy on the setup form with agentCount 3, run against any
small repo, watch the annotation table fill up in system messages
between agent turns — each turn's `Annotation update — X:
interest=N, confidence=M, total visits=K` line IS the pheromone
trail becoming visible.

---

## Session summary (Units 9–15, this conversation)

Seven units shipped in this session:

- **Unit 9** — Windows tree-kill for clean shutdown. Fixed the
  port-leak the user hit when Ctrl+C'ing `npm run dev`. Port
  cleanup now relies on `taskkill /T /F` instead of the SIGTERM
  path that Windows ignores.
- **Unit 10** — Council preset. First of the user's three-preset
  list. Parallel drafts with round-1 peer hiding; round-2+ reveals
  and agents revise.
- **Unit 11** — Blackboard honors `rounds` + auditor tightening.
  The MatSci-run post-mortem fix: blackboard's `rounds` slider
  finally has teeth, and the auditor no longer surrenders
  `wont-do` on first sight of missing files. E2E-validated on
  `kevinkicho/kmatsci040226` — run went from 1 commit / 0 test
  files to 5 commits / 3 real test files + CI workflow.
- **Unit 12** — Orchestrator–worker preset. Lead plans subtasks
  as JSON; workers execute isolated in parallel; lead synthesizes.
- **Unit 13** — Debate + judge preset. Fixed 3 agents: PRO vs CON
  exchange, JUDGE scores on final round. Proposition default =
  "This project is ready for production use", overridable via
  pre-start inject-message.
- **Unit 14** — Map-reduce preset. Mechanical round-robin
  partition of top-level repo entries; mappers isolated; reducer
  synthesizes. Side-steps LLM-planner laziness by using a
  deterministic partition.
- **Unit 15** — Stigmergy preset (standalone exploration). Shared
  annotation table; agents pick their own next file based on
  pheromone trail. No planner, no roles.

Roster after this session: **eight shipped presets** (round-robin
baseline + 7 intentional designs). Every pattern named in the
original catalog (`docs/swarm-patterns.md`) is now either shipped
or deferred with a documented rationale.

---

## Cross-phase notes

- **Event log.** A per-boot append-only JSONL log is written at `logs/current.jsonl` via `server/src/ws/eventLogger.ts` (landed alongside Phase 4 work, currently uncommitted). Every `SwarmEvent` the WS broadcasts gets a line, making post-hoc verification of runs possible even after the browser tab is closed.
- **Port pinning.** Backend 52243, web 52244 (`58fcf88`) — stable across restarts so `poke-blackboard.ps1` can hard-code the URL.
- **Terminal phases.** `poke-blackboard.ps1`'s terminal set includes `completed`, `stopped`, `failed` so a crashed run doesn't leave the script hanging.
