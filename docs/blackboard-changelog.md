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

## Phase 6 — Re-planning loop  **[pending]**

*Not started.* See `blackboard-plan.md` §Phase 6.

## Phase 7 — Stop conditions + safety valves  **[pending]**

*Not started.* See `blackboard-plan.md` §Phase 7.

## Phase 8 — UI board view  **[pending]**

## Phase 9 — Metrics + run artifact  **[pending]**

## Phase 10 — Polish + documentation  **[pending]**

---

## Cross-phase notes

- **Event log.** A per-boot append-only JSONL log is written at `logs/current.jsonl` via `server/src/ws/eventLogger.ts` (landed alongside Phase 4 work, currently uncommitted). Every `SwarmEvent` the WS broadcasts gets a line, making post-hoc verification of runs possible even after the browser tab is closed.
- **Port pinning.** Backend 52243, web 52244 (`58fcf88`) — stable across restarts so `poke-blackboard.ps1` can hard-code the URL.
- **Terminal phases.** `poke-blackboard.ps1`'s terminal set includes `completed`, `stopped`, `failed` so a crashed run doesn't leave the script hanging.
