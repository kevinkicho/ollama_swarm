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

## Phase 4 — Worker claim + execute (dry-run)  **[working tree, not yet committed]**

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

## Phase 5 — Real writes with optimistic CAS  **[working tree, not yet committed]**

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

## Phase 6 — Re-planning loop  **[working tree, partially complete]**

When a todo goes stale, the planner agent — not a dedicated replanner — is
prompted with the stale reason + current file contents and must either
**revise** the todo (new description + expected files) or **skip** it. See
[`known-limitations.md`](./known-limitations.md) §"Planner does double duty as
the replanner" for why one agent covers both roles.

### Step A — Replanner prompt + parser  **[working tree]**

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

### Step C — Runner wiring  **[working tree]**

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

### Step D — End-to-end smoke test  **[working tree; surfaced shutdown-race bug — see Step D-fix]**

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

### Step D-fix — Shutdown-race fix  **[working tree]**

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

## Phase 7 — Stop conditions + safety valves  **[in progress]**

Hard-cap a run so it always terminates, and capture final state on crash. See
`blackboard-plan.md` §Phase 7 for the step breakdown.

### Step A — Hard caps  **[working tree]**

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

### Step B — Crash snapshot  **[working tree]**

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

### Step C — E2E verification  **[pending]**

## Phase 8 — UI board view  **[pending]**

## Phase 9 — Metrics + run artifact  **[pending]**

## Phase 10 — Polish + documentation  **[pending]**

---

## Cross-phase notes

- **Event log.** A per-boot append-only JSONL log is written at `logs/current.jsonl` via `server/src/ws/eventLogger.ts` (landed alongside Phase 4 work, currently uncommitted). Every `SwarmEvent` the WS broadcasts gets a line, making post-hoc verification of runs possible even after the browser tab is closed.
- **Port pinning.** Backend 52243, web 52244 (`58fcf88`) — stable across restarts so `poke-blackboard.ps1` can hard-code the URL.
- **Terminal phases.** `poke-blackboard.ps1`'s terminal set includes `completed`, `stopped`, `failed` so a crashed run doesn't leave the script hanging.
