# Active work — queued + in-flight (across sessions)

> Persistent TODO list that survives between agent sessions. Per-session
> `TaskCreate` items die when the session ends; this file is the durable
> equivalent. **Update it when you finish or queue work.**
>
> Last refreshed: 2026-04-27

---

## Queued (waiting on user nod or specific trigger)

### Cloud-quota-burning validation

- **Multi-repo blackboard validation with V2 paths.** Only debate-tcg validated end-to-end so far (4 V2 commits, 0 divergences). Want at least 2-3 different repo types (small Python, larger TypeScript, doc-heavy) to surface scenarios the V2 worker pipeline hasn't hit yet (large hunks, conflicts, multi-file commits). **Trigger**: explicit user "go run multi-repo validation."

- **Long-horizon blackboard run with tier ratchet.** 2-4 hours of continuous mode against a target with a real directive. Validates pause/resume, audit cap behavior, tier promotion, stretch-goal reflection at scale. **Trigger**: explicit "go long-run."

### Risky cutovers (need stable validation first)

- **V2 Step 5c.3 — delete Board.ts.** Requires: USE_WORKER_PIPELINE_V2=1 default-on for 2+ stable runs (currently opt-in). When deleting: drop `Board.ts` (~330 LOC), `executeWorkerTodo` V1 path (~140 LOC), per-file lock cache (#205), v1ToV2TodoId Map. TodoQueueV2 becomes the queue (not a mirror). **Trigger**: 2+ blackboard runs with USE_WORKER_PIPELINE_V2=1 producing real commits + 0 V2 queue divergences.

- **V2 Step 6c — UI cuts over to event-log-derived state.** Currently EventLogReaderV2 is read-only (replay/debug); the live UI still derives state from WebSocket snapshots. Cutting over means the UI subscribes to the JSONL stream and rebuilds state via `deriveRunState`. **Trigger**: more user appetite for the V2 vision; could parallel-track first.

- **Drop opencode subprocess dependency entirely.** ~1 week of refactor:
  1. Wire `ollamaDirect` through the 6 non-blackboard runners (1d) — then USE_OLLAMA_DIRECT bypasses opencode for *all* presets
  2. Replace `AgentManager.spawnAgent` with our own session-state class (3d) — drops the opencode subprocess
  3. Delete `opencode.json` writing in `RepoService.ts`. Replace agent profile + tool-grant logic with our own simple config (2d)
  
  Result: single-binary install where users just need Ollama. **Trigger**: explicit "drop opencode."

### Smaller cleanups




---

## In-flight (active this/recent session)

*(Move items here from "Queued" when started; move to "Done recently" when shipped)*

— none right now —

---

## Data-grounded findings from 2026-04-27 blackboard run 04575ce4

20-min run with deepseek planner + V2 worker pipeline against
multi-agent-orchestrator. Artifacts in `runs/_monitor/04575ce4/`.

**Strong baseline**: 13 commits / 14 todos / 1 skipped / 1 stale
(recovered). 3/8 contract criteria met. Real refactor landed (notably
agent-3's `src/command-recovery.ts` -189-line cleanup). 0 console
errors in browser; 0 agent deaths; 0 idle-timeout strings; 0 V2
divergences. The Group A-E fixes held under load.

- ✅ **Sibling-model fallback (issue #3) verified live.** Issues report
  shows `model fallback attempts: 1`. Need to dig into the transcript
  to confirm the second attempt actually used a different model.

- **deepseek-v4-pro tool-call format mismatch.** Multiple JSON-parse
  failures in transcript caused by deepseek emitting raw XML tool
  calls (`<read path='...' start_line='...' />`) instead of the
  JSON envelope our parser expects. Recovery prompt fires correctly
  so it's not fatal, but generates churn. **Fix direction**: either
  (a) extend the parser to accept XML tool-call shape and translate
  to our internal format, (b) tighten the system prompt to forbid
  XML tool syntax explicitly, or (c) intercept XML output before
  the JSON parser sees it. **Trigger**: anytime; (b) is cheapest
  first attempt.

- **Reflection-pass cap gating is too soft.** Cap was 20 min;
  actual wallClockMs = 25.6 min (+5.6 min overshoot). My
  `isOverWallClockCap` gate is per-pass — if memory distillation
  starts at 19m30s with cap at 20m, it'll run for 3-5 more min
  past cap. **Fix direction**: hard cap watchdog that aborts
  in-flight reflection prompts once cap is hit (vs current per-
  pass gating). **Trigger**: anytime; small targeted fix.

- **agent.status not updated for goal-gen + reflection passes.**
  `goalGenerationPrePass.ts`, stretch-goal reflection, memory
  distillation, design memory update all use
  `planner.client.session.prompt(...)` directly, bypassing
  `promptAgent` which calls `markStatus(agent.id, "thinking")`.
  Result: UI shows agent.status="ready" while these passes are
  actively running. **Fix direction**: route all four through
  `promptAgent` (or a new helper that does markStatus + the same
  retry/streaming logic). **Trigger**: anytime; medium-touch but
  centralizes prompt routing.

---

## Data-grounded findings from 2026-04-27 blackboard run 0254ca7c

15-min run with deepseek-v4-pro planner; artifacts in `runs/_monitor/0254ca7c/`
plus the actual run output at `C:\mnt\c\Users\kevin\Desktop\ollama_swarm\runs\debate-tcg\` (wrong path — see #PATH below).

- ✅ **CRITICAL — path mangling at the REST boundary.** Fixed in `1ec038d` — `normalizeWslPath()` utility at the route layer in `routes/swarm.ts` (both `/preflight` and `/start`). `/mnt/<drive>/<rest>` → `<DRIVE>:\<rest>` on Windows; no-op everywhere else. 13 unit tests. End-to-end verified via preflight: `/mnt/c/Users/.../runs` → `C:\Users\...\runs\debate-tcg`.

- ✅ **wallClockCapMs not enforced** — fixed. Root cause: post-audit reflection passes (stretch goals, memory distillation, design memory update) ran unconditionally even after the audit loop ended past the cap. Each is a 1-3 min planner prompt; on run 0254ca7c that pushed 14-min audit work to 19 min total. Fix gates each pass on `isOverWallClockCap()` (a non-mutating cap probe); when over, transcript surfaces a clear "cap exceeded; skipping bonus passes" message. Test suite (987/987) clean.

- **AUDIT: review all JSON formatting scenarios end-to-end.** Each `summary.kind` bubble (run_finished, seed_announce, verifier_verdict, agents_ready, council_draft, debate_turn, council_synthesis, stigmergy_report, mapreduce_synthesis, role_diff_synthesis, stretch_goals, debate_verdict, next_action_phase, worker_hunks) has its own renderer in `web/src/components/transcript/MessageBubble.tsx`. The fallback chain (worker_hunks-detection → AgentJsonBubble → JsonPrettyBubble → segmented-prose → CollapsibleBlock) also needs verification. **Trigger**: anytime; method = render each kind in browser, screenshot, compare to expected. Pairs with the SSE-streaming-collapsible regression below — likely some are broken by the same root cause (commit `0b3cda6` outer-div wrap).

- **REGRESSION: SSE streaming formatting via collapsibles broken.** Kevin reported "it worked previously but now its not." Most likely caused by commit `0b3cda6` (MessageBubble wrap with `data-entry-id` outer div) — wrapping the content in a new bare `<div>` may have changed the DOM structure that `useSegmentSplitter` / `StreamingDock` / `CollapsedSegment` rely on for collapsible-on-stream rendering. **Trigger**: anytime; investigate by checking whether the outer wrapper interferes with sticky-bottom scroll, segment measurement, or streaming-dock placement. Possible fix: move the data attrs onto the EXISTING outer wrapper of each child bubble (SystemBubble / AgentBubble / CollapsibleBlock) rather than adding a new wrapper.

- ✅ **Issue #1 (OllamaClient 60s idle)** — fixed. Now uses two-phase timeout: `firstChunkTimeoutMs` (default 180s) until first body chunk arrives, then `idleTimeoutMs` (default 60s) steady-state. Heavy reasoning models (deepseek-v4-pro, etc.) get the cold-start tolerance they need without weakening steady-state liveness. Mirrors the same pattern applied to streamPrompt for the SSE path.

- ✅ **Issue #3 (planner empty → repair → 0-todos)** — fixed. Drove the design call: hardcoded sibling-model pair (deepseek↔nemotron via `SIBLING_MODELS` map in `BlackboardRunner.ts`), per-prompt model swap on the same opencode session (no agent re-spawn), one fallback attempt with `isFallbackAttempt` flag preventing infinite recursion. Per-run override via `cfg.plannerFallbackModel` for callers who want a different fallback. When fallback also produces 0 todos, falls through to the existing loud-warn + `stopReason: "no-progress"` path with " (sibling-model fallback also produced 0 todos)" appended.

- **Monitor script reads wrong summary.json.** It hardcodes `runs/<repo>/summary.json` (WSL path). When the path mangling above fires, it reads stale data. **Fix direction**: monitor should look up summary by `runId` match, or probe both `/mnt/c/...` and `C:\mnt\c\...` paths. **Trigger**: anytime; small fix.

- **Playwright capture still gets 0 bubbles** — no `data-entry-id` on MessageBubble's wrapping div. Already in queue as the issue #4 follow-up. **Trigger**: explicit "make transcript entries Playwright-friendly."

- **deepseek-v4-pro mean latency = 65s/turn (planner role, 4 turns)** in this run. The provisional 35s I added to `WallClockEstimate.tsx` is too low. Needs ≥5 runs of data before re-estimating, but heads-up: estimate is currently underselling deepseek's wall-clock budget. **Trigger**: re-estimate after a few more runs land.

---

## Data-grounded findings from earlier 2026-04-27 blackboard run f78342b7

Each item below is anchored to an artifact in `runs/_monitor/f78342b7/`. Do
not promote any of these to "needs-fixing" without re-checking the artifact.

- **Issue #3 — planner empty → repair → 0-todos** is structural. f78342b7
  reproduced it with no model fallback attempted. Visibility fix in commit
  `b794703` makes the failure loud; the **structural fix (model fallback
  when planner returns empty/garbage)** is queued. **Trigger**: explicit
  "design model-fallback for planner-empty."

- **Issue #1 — OllamaClient 60s idle timer** was NOT exercised in f78342b7
  (no `Ollama idle timeout` strings). The empty response in this run came
  from a different cause (Ollama returned an empty response body within the
  timer, before the 60s elapsed). Need a separate reproducer that forces
  cold-start >60s. **Trigger**: explicit "reproduce cold-start idle
  timeout" — likely needs a fresh Ollama process or deliberately-slow model.

- **Issue #4 — WebUI bubble routing** partially verified. `run_finished`
  bubble works (now amber for no-progress, emerald for completed — see
  commit `b794703`). Earlier planner-output bubbles weren't captured
  because Playwright's selector net (`[data-entry-id]`, `.transcript-entry`,
  etc.) doesn't match anything in the current React tree — there are no
  stable per-entry attributes. **Trigger**: explicit "make transcript
  entries Playwright-friendly" — add `data-entry-id={entry.id}` +
  `data-summary-kind={summary?.kind}` to MessageBubble's wrapping div.

- **`npm test` script is bash-only** — current `OPENCODE_SERVER_PASSWORD=test-only npm test`
  prefix syntax fails when run from Windows `cmd.exe`. Tests work via
  `cmd.exe /c "set OPENCODE_SERVER_PASSWORD=test-only && ..."` but that's
  manual. **Trigger**: anytime; cross-env or a small shim wrapper.

---

## Done recently (last 30 days; older lands in archive/blackboard-changelog.md)

### 2026-04-27 — late session: bug-fix round

- ✅ `1ec038d` — WSL parentPath normalization at the route boundary. Prevents the `C:\mnt\c\...` parallel-tree bug surfaced by run 0254ca7c. New `server/src/services/pathNormalize.ts` + 13 unit tests. Both `/api/swarm/preflight` and `/api/swarm/start` apply the normalization; downstream code sees correct Windows paths so the auditor reads the same files the worker wrote to.
- ✅ Default model swap: `glm-5.1:cloud` → `deepseek-v4-pro:cloud` (Kevin pulled + verified). Replaced in: `config.ts`, `.env.example`, `App.tsx` header, `BlackboardRunner.ts:2155` fallback, `scripts/poke-blackboard.ps1`, `SetupForm.tsx` MODEL_REASONING constant, `WallClockEstimate.tsx` (provisional 35s/turn). `nemotron-3-super:cloud` and `glm-5.1:cloud` remain available — type explicitly into the form's Model field.
- ✅ `b794703` — issue #2 + #3 visibility + port defaults + monitor tooling
  - blackboard: stopReason="no-progress" for 0-work runs (was masquerading as "completed")
  - planner-empty system message now loud about the failure mode
  - default ports 52243/52244 → 8243/8244 (Windows Hyper-V reserved range)
  - new `scripts/monitor-blackboard-issues.mjs` + `scripts/capture-ui-snapshots.mjs`
  - Playwright added as devDependency for ongoing UI verification

### 2026-04-27 (earlier session)

- ✅ V2 substrate complete through Steps 1–6a (commits `fa7ff71` through `94413bd`)
- ✅ Step 5c.1 parallel-track TodoQueueV2 mirror (`41fa509`)
- ✅ Step 5c.2 opt-in V2 worker pipeline gated by `USE_WORKER_PIPELINE_V2=1` (`7040a96`)
- ✅ Step 6b `/api/v2/event-log` endpoint + `EventLogPanel` UI (`70e7c2b`)
- ✅ `bb0c509` — proxy always terminates rewritten OLLAMA_BASE_URL with /v1 (defensive)
- ✅ `18a7749` — streamPrompt filters stale session.idle from prior session.prompt's tail
- ✅ `189ca05` — replaced wall-clock 4-min absolute turn cap with SSE-aware liveness watchdog
- ✅ `cfee38d` — agents_ready structured summary + expandable per-agent grid
- ✅ `3ad6869` — fixed npm test by adding OPENCODE_SERVER_PASSWORD=test-only prefix (unblocked 47 tests)
- ✅ `3f54bb5` + `d6a4864` — docs refresh: STATUS.md, archive, journal cleanup, function-ref drop
- ✅ Validated 7/7 SDK-path presets clean against debate-tcg with all 4 fixes in place

### 2026-04-26

- V2 Step 1 — OllamaClient direct chunked-HTTP path (commits `8de4eb1`, `4f85b00`, `bc9464b`)
- V2 Step 2a/b/c — extractJson + TranscriptEntrySummary + summarizeAgentJson moved to shared/ (`ce99504`, `fc5c06f`, `6f5c97f`)
- See git log for older shipped work + `docs/archive/blackboard-changelog.md` for the deeper journal

---

## Conventions for this file

- **Add an entry when you queue work.** Don't trust your in-session task list to survive.
- **Move to "In-flight" when you start.** Helps the next agent see what's mid-progress.
- **Move to "Done recently" with a commit hash when shipped.** Items older than ~30 days can fall off (commit hash + git log is the durable record).
- **Trigger field is required for "Queued."** Forces clarity about what unblocks the work.
- **Don't list work that doesn't exist yet** ("we should add X" without a concrete reason). This is a TODO, not a wish list.
