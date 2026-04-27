# Blackboard Preset — Phased Implementation Plan (HISTORICAL — shipped)

> **Status:** the blackboard preset has shipped, all phases described
> here are in production. This doc remains for the design rationale +
> phase ordering it captures (useful when working on related areas).
> For current architecture, see [`STATUS.md`](./STATUS.md) and
> [`../server/src/swarm/blackboard/ARCHITECTURE.md`](../server/src/swarm/blackboard/ARCHITECTURE.md).
> For the V2 roadmap superseding this plan's "what's next" sections,
> see [`ARCHITECTURE-V2.md`](./ARCHITECTURE-V2.md).

---

Companion doc to [`swarm-patterns.md`](./swarm-patterns.md). This plan breaks
the first preset build (blackboard, optimistic-CAS, small atomic units) into
phases small enough that each one is independently testable and revertable.

Every phase ends with:
- a working app (round-robin never regresses),
- a verification test that we actually run,
- one commit.

If a phase fails verification, we revert that commit and think harder before
re-attempting. No phase gets skipped.

---

## Objectives

- Ship `blackboard` as a second selectable preset on the setup page.
- Preserve round-robin behavior exactly — it is our fallback and our
  before/after benchmark.
- Agents **actually modify files** in the clone (round-robin is talk-only).
- Stale plans are caught via **optimistic CAS on file SHA hashes**.
- Every todo is an **atomic unit** — ≤2 files per commit, one logical change.
- Runs are bounded (wall-clock cap, todo cap, commit cap) and the user can
  Stop at any time with no dangling children or claims.
- Every run leaves a durable artifact on disk we can diff and inspect.

## Non-goals (v1)

- Multi-node / distributed blackboard. Single process, in-memory + JSON-on-disk.
- Cross-run persistence. Each Start wipes state.
- Auto-PR / auto-push. Changes land on the current branch; user reviews.
- Smart three-way merge. If CAS fails, we re-plan — we do not auto-merge.
- Replacing the Transcript UI. Board is a new tab; transcript stays.

## Design decisions locked in before we start

1. **Diff shape = full-file replacement.** Worker outputs `{file, newText}` for
   each touched file. Blunt but trivially validatable. Patch-based diffs are
   a v2 concern.
2. **State lives in `runs/<slug>/board.json`**, written on every mutation.
   Single writer (the runner), no concurrent-process concerns. Survives crash.
3. **Planner and workers are distinct roles.** Same model, different system
   prompts, different loops. Planner never claims todos; workers never invent
   them.
4. **Tool-use stays off for workers.** They output structured JSON diffs; the
   Node runner writes to disk after CAS. Keeps CAS server-authoritative.
5. **Round-robin code is not refactored aggressively.** We add a thin runner
   abstraction around it; internals are left alone.

---

## Phase 0 — Preset dispatch layer (no behavior change)

**Goal:** add a `SwarmRunner` interface so presets plug in symmetrically.
Round-robin output must be byte-identical to before.

**Deliverables:**
- `server/src/swarm/SwarmRunner.ts` — interface `{ start(cfg), stop(), status(), injectUser(text) }`.
- `server/src/swarm/RoundRobinRunner.ts` — wraps current `Orchestrator` logic; no new behavior.
- `server/src/services/Orchestrator.ts` becomes a router: picks runner by `cfg.preset`.
- `server/src/routes/swarm.ts` zod schema: `preset: z.enum([...]).default("round-robin")`.
- Unknown preset → 400 with a friendly message.

**Verification:**
- Run round-robin on `is-odd` before and after the change. Diff the transcripts. Should match up to timestamps.
- `preset: "blackboard"` returns 501 "not implemented yet (phase 0 scaffold)".

**Risks:**
- Breaking round-robin while refactoring. *Mitigation:* do the minimum refactor — extract an interface, don't reshape state.

## Phase 1 — Board data model + in-memory store

**Goal:** pure, unit-testable `Board` class. No agents, no WebSocket, no routes.

**Deliverables:**
- `server/src/swarm/blackboard/types.ts`:
  - `Todo { id, description, expectedFiles: string[], createdBy, createdAt, status: 'open'|'claimed'|'committed'|'stale'|'skipped', staleReason?, replanCount }`
  - `Claim { todoId, agentId, fileHashes: Record<path, sha>, claimedAt, expiresAt }`
  - `Finding { id, agentId, text, createdAt }`
- `server/src/swarm/blackboard/Board.ts`:
  - `postTodo`, `claimTodo` (atomic check-and-set), `commitTodo` (CAS compare on hashes), `markStale`, `reclaim`, `expireClaims(now)`, `postFinding`, `snapshot()`.
- `server/src/swarm/blackboard/Board.test.ts` — covers every path, including concurrent `claimTodo` on the same todo.

**Verification:**
- `npm test` green.
- Concurrency test: 2× `claimTodo` for the same todo, only one wins.
- CAS test: commit with a changed hash fails deterministically.

**Risks:**
- Data shape churn in later phases. *Mitigation:* keep optional fields truly optional; avoid premature fields (priority, labels, etc. can wait).

## Phase 2 — Board events over WebSocket

**Goal:** typed board events reach the browser. UI doesn't render them yet, but dev-tools can observe them.

**Deliverables:**
- New `SwarmEvent` variants in `server/src/types.ts` and `web/src/types.ts`:
  - `board_todo_posted`, `board_todo_claimed`, `board_todo_committed`, `board_todo_stale`, `board_todo_skipped`, `board_finding_posted`, `board_state` (full snapshot, sent throttled).
- `Board` takes an `emit` callback in its constructor.
- A **temporary dev route** `POST /api/dev/board-poke` that creates a dummy Board and fires each event type. Deleted at end of phase.

**Verification:**
- Hit the dev route; watch events flow in browser WS inspector.
- Snapshot events are throttled to ≤2/sec even under rapid mutations.

**Risks:**
- Event storms at 6+ agents. *Mitigation:* `board_state` is coalesced via `setTimeout(…, 0)` with a trailing-edge flush.

## Phase 3 — Planner agent role (read-only)

**Goal:** one agent reads the repo state and produces an initial todo list. No workers yet. No file writes.

**Deliverables:**
- `server/src/swarm/blackboard/prompts/planner.ts`:
  - System prompt demands **JSON array output**: `[{"description": "...", "expectedFiles": ["..."]}, ...]`.
  - Constraints: each todo touches ≤2 files, description is one sentence, expectedFiles are relative paths.
- `server/src/swarm/blackboard/BlackboardRunner.ts` (skeleton):
  1. Spawn 1 agent labeled `planner`.
  2. Prompt it with the seed (repo URL, top-level tree) + planner system prompt.
  3. Parse JSON; on parse failure, retry once with a "repair" prompt.
  4. Validate each todo (≤2 files, non-empty description). Drop invalid ones with a system-message note.
  5. `board.postTodo` for each valid todo; emit `board_state`.
  6. Phase transitions: `cloning` → `spawning` → `planning` → `idle` (end of phase 3).

**Verification:**
- Start blackboard preset on `is-odd`. Planner posts ≥1 valid todo within 2 min.
- Feed the planner a broken repo (empty clone); it posts zero todos and a finding explaining why.
- Force a non-JSON response (test-hook): repair prompt triggers exactly once.

**Risks:**
- Planner writes prose outside JSON. *Mitigation:* the repair prompt says "Your last output was not valid JSON. Output ONLY a JSON array, nothing else."
- Planner proposes huge todos (touching 10 files). *Mitigation:* validator drops them and asks for a slimmer version once.

## Phase 4 — Worker claim + execute (dry-run)

**Goal:** workers spawn, claim todos, produce diffs as JSON, log "would commit". **No real file writes.** This is the prompt-engineering phase — we tune the worker prompt without risking the disk.

**Deliverables:**
- `BlackboardRunner` now spawns `agentCount - 1` workers alongside the planner.
- `prompts/worker.ts`: system prompt demanding JSON `{diffs: [{file, newText}]}` output. No prose.
- Worker loop per agent:
  1. Poll board every 2s for `open` todos.
  2. On find: `board.claimTodo(id, agentId, hashes)`. If lost race, back off.
  3. Fetch file contents for `expectedFiles`. Hash them (SHA256).
  4. Prompt worker with todo + current file contents.
  5. Parse diff JSON; validate (files match expected, newText non-empty, length sanity).
  6. **Skip actual write.** Log `[agent-N] would commit {files}` as a system entry.
  7. Call `board.commitTodo` (with hashes unchanged since no one else is writing yet — trivially passes CAS).
  8. Emit events.
- Per-worker cooldown after commit (~5s) to prevent one worker hogging the board.
- Claim TTL = 10 min; `expireClaims` runs every 30s.

**Verification:**
- Run on `is-odd`: planner posts todos, workers drain them, board ends empty. No files changed.
- `git status` inside the clone = clean after the run.
- Induce a claim race (spawn 4 workers, 1 todo): only one commits, others back off.

**Risks:**
- One worker grabs every todo. *Mitigation:* per-worker cooldown + small randomized jitter on poll interval.
- Malformed JSON. *Mitigation:* one repair retry per todo; else `markStale("worker produced invalid JSON")`.
- Stuck worker (no SSE activity). *Mitigation:* existing idle-watchdog from Orchestrator — port it into the worker loop.

## Phase 5 — Real writes with optimistic CAS

**Goal:** workers actually modify files. Commits are CAS-checked against claim-time hashes.

**Deliverables:**
- Worker step 7 becomes:
  1. Re-read each file in `Claim.fileHashes` and re-hash.
  2. If any live hash ≠ claim-time hash → `board.markStale(id, "file X changed since claim: hash mismatch")`. **Do not write.** Emit `board_todo_stale`.
  3. If all match → for each diff, write to `<file>.tmp`, fsync, atomic-rename to `<file>`. Then `board.commitTodo`.
- New files: claim-time hash is the empty string `""`; still CAS-checked (file must not exist at commit time).
- Writes restricted to paths inside `cfg.localPath`. Resolve symlinks; reject anything outside.
- `.git/` is always rejected.

**Verification:**
- Smoke on `is-odd`: agents actually add files/change files; `git diff` shows the changes.
- Forced collision test: run with 2 overlapping todos manually. One commits, the other goes stale. Transcript shows the stale reason.
- Safety test: craft a todo whose `expectedFiles` escapes the clone (`../foo`). Worker must reject.

**Risks:**
- Partial write crash (lose file content). *Mitigation:* tmp-file + rename is atomic on POSIX and near-atomic on NTFS. Good enough for v1.
- UTF-8 BOM sneaks in. *Mitigation:* write with explicit `utf8` no-BOM; sanity-check worker output for BOM bytes.
- Worker emits an empty `newText` when old was non-empty. *Mitigation:* reject the diff; `markStale("worker produced empty file")`.

## Phase 6 — Re-planning loop

**Goal:** stale todos get revised by the planner rather than skipped or retried blindly.

**Deliverables:**
- Planner watcher loop:
  - Fires on `board_todo_stale` event AND every 20s as a fallback.
  - For each stale todo with `replanCount < 3`: prompt planner with "This todo went stale because X. Current state of affected files: {...}. Produce a revised todo, OR mark it as no-longer-needed."
  - Planner returns either `{revised: {description, expectedFiles}}` → replaces todo with `replanCount++`, status → `open`; or `{skip: true, reason: "..."}` → status → `skipped`.
- After `replanCount === 3` → auto-`skipped` with a system message. No further retries.

**Verification:**
- Induce a stale case. Watch it get replanned and re-committed on the next attempt.
- Induce 4 consecutive stales on the same todo. It gets skipped on the 4th, not retried forever.

**Risks:**
- Planner/worker race on the same file. *Mitigation:* planner only reads; workers claim. No overlap.
- Replan thrash. *Mitigation:* the hard cap at `replanCount=3`.

## Phase 7 — Stop conditions + safety valves

**Goal:** the run always terminates cleanly.

**Deliverables:**
- "Done" detection: no `open` todos AND no active claims AND planner idle ≥30s AND no stale todos pending replan.
- Hard caps (configurable, with sane defaults):
  - Max wall-clock: 20 min.
  - Max total commits: 20.
  - Max total todos (including replans): 30.
- User Stop: abort all sessions, expire claims, mark phase `stopped`. **Committed changes are NOT rolled back** — leave them for the user to review.
- Crash handler: on uncaught exception, snapshot board to `runs/<slug>/board-final.json`, set phase `failed`, emit error event.

**Verification:**
- Hit Stop mid-claim → no dangling children, no orphaned claims, UI reflects `stopped`.
- Force exception mid-run → `board-final.json` exists and matches last emitted state.
- Run a large repo; wall-clock cap fires cleanly.

**Risks:**
- Windows child-process cleanup. *Mitigation:* existing `taskkill /T` pattern from round-robin.

## Phase 8 — UI: board view

**Goal:** the user sees the board in real time. Transcript tab stays.

**Deliverables:**
- `SwarmView` gets a `Transcript | Board` tab switcher.
- `web/src/components/BoardView.tsx`:
  - Five columns: Open, Claimed, Committed, Stale, Skipped.
  - Each card: description, expectedFiles, claimer (if any), age, replanCount badge.
  - Stale cards show stale reason.
- `web/src/state/store.ts`: `todos: Record<id, Todo>`, `findings: Finding[]`, reducers for each board event.
- Findings pane (collapsible) below the columns.

**Verification:**
- Run end-to-end; watch cards move through columns in real time.
- Transcript tab still works.
- Performance: 20 todos × 6 agents flipping claims should not jank the UI (memoize cards, batch updates).

**Risks:**
- Too many re-renders. *Mitigation:* `React.memo` on cards, keyed by `todoId + status`.

## Phase 9 — Metrics + run artifact

**Goal:** every run leaves a summary a human can read.

**Deliverables:**
- On run end (success, stop, or crash): write `runs/<slug>/summary.json`:
  - `wallClockMs`, `commits`, `staleEvents`, `skippedTodos`, `filesChanged`, `startedAt`, `endedAt`, `stopReason`, `finalGitStatus`.
  - Per-agent: `tokensIn/out` (if OpenCode SDK exposes it; else null), `turnsTaken`.
- UI shows a summary card in the Board tab when phase ∈ {completed, stopped, failed}.

**Verification:**
- Run to completion; open `summary.json` and inspect.
- Run and Stop early; summary still written with `stopReason="user"`.

## Phase 10 — Polish + documentation

**Deliverables:**
- `docs/swarm-patterns.md`: flip blackboard from `[~]` to `[x]`.
- `README.md`: add "Blackboard preset" section with one walkthrough.
- `SetupForm.tsx`: blackboard preset `status: "active"`. Raise its `max` if we've verified 8 agents is stable.
- Inline help text explaining CAS and stale-replan in one sentence.

---

## Sequence

```
0  Preset dispatch           (scaffold, no UX change)
1  Board data model          (unit-tested, no UI)
2  Board WebSocket events    (dev-route proof)
3  Planner role              (read-only, prose → JSON todos)
4  Worker dry-run            (claim + simulate, no writes)
5  Real writes + CAS         (the risk phase)
6  Re-plan loop              (stale → revised)
7  Stop conditions           (hard caps, clean exit)
8  UI board view             (Transcript | Board tabs)
9  Metrics + artifact        (summary.json)
10 Polish                    (flip [~] → [x])
```

Phases are strictly sequential. 2 can parallelize with 3 if we scope carefully.

## Rollback

Each phase = one commit. If phase N breaks, `git revert` phase N. Round-robin
is untouched after phase 0, so it remains a working fallback at every step.

## Testing philosophy

- Phase 0: round-robin smoke test must still pass (compare transcripts).
- Phase 1: unit tests for `Board`.
- Phases 3–6: integration tests against `runs/sandbox/` so we don't keep
  re-cloning `is-odd`.
- Phase 7: chaos tests — kill worker mid-claim, force crash, hit Stop mid-plan.
- All phases: `npm run build` clean, no TypeScript errors, no new warnings.

## Open questions (park until we hit them)

1. **Token cost.** 6 agents × small todos × re-plans could get expensive.
   Add a per-run token budget in Phase 9 if it bites.
2. **Branch strategy.** Auto-create `swarm/<timestamp>` branch at start?
   Safer but adds git complexity. Default v1: use whatever is checked out.
3. **Heartbeats.** Claim TTL of 10 min is coarse. Workers could heartbeat
   to extend. v1: skip; long TTL is fine at this scale.
4. **Planner as worker.** Should planner also claim todos when idle?
   v1: no — dedicated role. Reconsider at small agent counts.
5. **Event storm UX.** 6 agents × constant streaming could overwhelm the
   Transcript tab. May need per-agent collapse or virtualized list in
   Phase 8.

---

## Checkpoints for the human

At the end of each phase, before moving to the next, I will:

1. Report what was done and what was verified.
2. Surface anything surprising or unplanned.
3. Wait for your go-ahead before starting the next phase.

No phase starts until the previous one is signed off.
