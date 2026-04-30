# Active work — queued + in-flight (across sessions)

> Persistent TODO list that survives between agent sessions. Per-session
> `TaskCreate` items die when the session ends; this file is the durable
> equivalent. **Update it when you finish or queue work.**
>
> Last refreshed: 2026-04-29

---

## Queued (waiting on user nod or specific trigger)

### Cloud-quota-burning validation

- **Multi-repo blackboard validation with V2 paths.** Only debate-tcg validated end-to-end so far (4 V2 commits, 0 divergences). Want at least 2-3 different repo types (small Python, larger TypeScript, doc-heavy) to surface scenarios the V2 worker pipeline hasn't hit yet (large hunks, conflicts, multi-file commits). **Trigger**: explicit user "go run multi-repo validation."

- **Long-horizon blackboard run with tier ratchet.** 2-4 hours of continuous mode against a target with a real directive. Validates pause/resume, audit cap behavior, tier promotion, stretch-goal reflection at scale. **Trigger**: explicit "go long-run."

### Risky cutovers (need stable validation first)

- ✅ **V2 Step 5c.3 — delete Board.ts.** SHIPPED 2026-04-28 during V2 cutover Phase 2c. Confirmed 2026-04-29 audit: `Board.ts` no longer exists; only stale comments in BlackboardRunner / TodoQueue reference its prior existence. (active-work.md note was stale.)

- **V2 Step 6c — UI cuts over to event-log-derived state.** Foundation slice (`useEventLogStream` hook + `EventLogMirrorPanel` + `?useEventLogRunId=1` field cutover) shipped 2026-04-29. Full cutover (every WS dispatch path replaced with event-log derivation) genuinely pending. ~1-2 days. **Trigger**: more user appetite for the V2 vision; could parallel-track first.

- ✅ **E3 — Drop opencode subprocess dependency.** SHIPPED 2026-04-29 across multiple commits. Phases 1-5 complete:
  - Phase 1 (`8dcf0b5`): SessionProvider abstraction + 3 raw-HTTP impls (Ollama / Anthropic / OpenAI)
  - Phase 2 (`f44fb28`): promptWithRetry + BaselineRunner route through pickProvider behind `USE_SESSION_PROVIDER`
  - Phase 3 (`47b15ba`, `2603d5b`, `e4f377c`, `fd5d6de`, `76e9e28`): all 9 runners spawn without opencode + 5 direct session.prompt callers migrated via chatOnce + onChunk streaming preserved
  - Phase 4 (`18facec`, `20aa431`, `0416d97`, `5461575`, `75a7505`): ToolDispatcher (read/grep/glob/list/bash) + Anthropic tool_use loop + OpenAI tool_calls loop + dispatcher wired through chatOnce + promptWithRetry
  - Phase 5: defaults for USE_SESSION_PROVIDER + USE_SESSION_NO_OPENCODE flipped to TRUE — opencode subprocess unreachable on the default path
  
  Remaining cleanup (low priority): physically delete `@opencode-ai/sdk` from `server/package.json` + `AgentManager.spawnAgent` (legacy path) + `RepoService.writeOpencodeConfig`. The dep stays in tree as an escape hatch (`USE_SESSION_NO_OPENCODE=false`) until the new defaults bake across enough runs. **Trigger for cleanup**: explicit "delete opencode dep" after the new defaults have run cleanly for several weeks.

### Smaller cleanups




---

## In-flight (active this/recent session)

*(Move items here from "Queued" when started; move to "Done recently" when shipped)*

### 2026-04-29 — multi-provider + scoreboard

— see "Done recently → 2026-04-29" below for the 7-phase plan (#314–#320) + CI fix (#313) shipped today; live validation pending —

**Verified ALREADY shipped during 2026-04-29 doc audit (notes in this file were stale):**
- Playwright-friendly transcripts: `MessageBubble.tsx:48-54` already has `data-entry-id`, `data-entry-role`, `data-summary-kind`, `data-agent-index`, `data-has-thoughts`, `data-has-tool-calls`.
- Think-tag rendering: server splits `{thoughts, finalText}` via `shared/extractThinkTags`; web's `ThoughtsBlock` renders thoughts collapsed-by-default above the main bubble.
- Contract bubble structured expand: `web/src/components/transcript/ContractBubble.tsx` is a 3-tab interactive component (Summary / All N criteria / JSON). Replaces JsonPrettyBubble fallback for the planner's contract envelope.
- Streaming-collapsibles content-boundary segmentation: `useSegmentSplitter.ts:32-70` implements `findContentBoundaries` (`\n\n` / code fences / markdown headers / `<think>` tags). Pause-based is a 15s fallback only.
- Tool-call marker over-segmentation: server-side `stripAgentText` removes markers BEFORE the segmenter sees them, so the 28-micro-segment scenario can no longer reach the UI.

### Surfaced from overnight tour (queued for next session)

- **#231 — XML pseudo-tool-call markers ROOT-CAUSED 2026-04-29 (training-prior, not opencode).** Investigation findings:

  - The opencode v2 SDK (`node_modules/@opencode-ai/sdk/dist/v2/`) does NOT contain any XML tool-call format anywhere; greps for `tool_use` / `<read` / `<grep` / `XML.*tool` return zero hits. Hypothesis B (opencode injects XML examples) ruled out.
  - The PLANNER_SYSTEM_PROMPT already has explicit rule 1a (2026-04-27): `Do NOT emit raw XML tool-call syntax... that's the SDK's internal tool-call format`. Models still emit it → prompting alone can't fix this. Hypothesis A ruled in (training prior).
  - Both `glm-5.1:cloud` and `nemotron-3-super:cloud` route through Ollama's OpenAI-compatible bridge. When opencode declares `read`/`grep`/`glob` as tools via the OpenAI function-call schema, the model's weights reach for whatever tool format they were trained on — for many open-weights coding models, that's Anthropic-style XML tags (since those leaked into training corpora as exemplars). Hypothesis C confirmed: this is an OpenAI-bridge mismatch.

  **Practical impact:** the markers get stripped server-side via `shared/stripAgentText` (#229/#230) so runs still complete; the cost is wasted tokens emitting XML the runner discards.

  **Three actionable fixes, ranked:**
  1. **Try with Anthropic provider** (now possible post-#314). If Claude models don't emit the XML mismatch when opencode targets the native Anthropic API directly (no OpenAI-bridge translation), this becomes a "use the right provider for tool-using prompts" doc note. **Trigger**: paste an `ANTHROPIC_API_KEY` + run a blackboard planner turn against `anthropic/claude-sonnet-4-6` — observe whether `<read>` tags still appear.
  2. **Add an XML→JSON tool-call translator** in `extractUsageFromMessageInfo`'s sibling slot — when the parser sees `<read path="X">`, dispatch a real `read` tool call against the clone, splice the result back into the prompt, re-prompt the model. Reproduces what an "agent loop" would do. ~6h work, complex error paths, fragile.
  3. **Strip tool grants from the planner profile** (set `swarm-read` permissions for planner-only sessions to `*: deny`). Cost: planner can't grep before emitting TODOs → drops the grounding loop the prompt relies on. Likely net-worse for run quality. Not recommended unless live testing shows wasted-token cost dominates over grounding benefit.

  **Recommended next step:** option 1 — cheap experimental check that probably solves the problem entirely without code changes. Pair with the live UI test of multi-provider work. **Trigger**: when running the first Claude-keyed test session.

- **First paid scoreboard sweep + 7 more fixtures.** Phase 6 shipped 3 starter fixtures + the framework; 7 more are queued in `eval/fixtures/README.md` (add-null-guard, extract-pure-helper, fix-failing-test, audit-console-logs, categorize-deps, multistep-add-script, multistep-config-then-test). After at least 5 fixtures land, run a 3-seed × Sonnet 4.6 sweep (~$5–15) and overwrite `eval/RESULTS.md` with real numbers. **Trigger**: explicit "go run paid sweep" with budget authorization.

- **Live UI test of multi-provider work.** The 90-second Playwright demo on 2026-04-29 confirmed the dropdown + autocomplete + cost-cap-field-reveal all work visually. NOT yet exercised: a real Anthropic-keyed run that flows through opencode subprocess → AI-SDK package → token capture → cost-cap stop. **Trigger**: paste an `ANTHROPIC_API_KEY` into `.env` + explicit "kick a $0.10-capped Claude run."

- **summary.kind bubble re-audit.** 14+ envelope kinds (run_finished, seed_announce, verifier_verdict, agents_ready, council_draft, debate_turn, council_synthesis, stigmergy_report, mapreduce_synthesis, role_diff_synthesis, stretch_goals, debate_verdict, next_action_phase, worker_hunks). Render each in browser, screenshot, compare to expected. The 34/34 BubbleGallery audit (2026-04-28) covered them at fixture level — this is the live-data version that catches regressions from the 2026-04-29 multi-provider work. **Trigger**: anytime; pair with the live UI test above.

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

- ✅ **deepseek-v4-pro tool-call format mismatch** — fixed (rule 1a added to all 4 prompt system messages: planner, first-pass-contract, auditor, replanner). Tells the model explicitly: do NOT emit raw `<read path='...' />` XML; use the actual SDK tool functions; visible response = JSON only. If deepseek still emits XML, parser-side stripping is the follow-up.

- ✅ **Reflection-pass cap gating is too soft** — fixed via hard-cap watchdog. New `setInterval` polls `isOverWallClockCap` every 5s during the reflection block; on cap-hit, fires `reflectionAbort.signal` which forwards through `ReflectionContext.signal` to each pass's `session.prompt({signal})` call. In-flight reflection prompts now get aborted at the cap boundary, not allowed to run for 3-5 more min.

- ✅ **agent.status not updated for goal-gen + reflection passes** — fixed via callback. `goalGenerationPrePass` + each of the 3 reflection passes now accept an `onStatusChange("thinking"|"ready")` callback. Runner provides one (via new `markPlannerStatus` helper) that calls `manager.markStatus` + `emitAgentState`, restoring the truthful UI signal. UI now shows the planner as "thinking" during these passes.

---

## Data-grounded findings from 2026-04-27 blackboard run 0254ca7c

15-min run with deepseek-v4-pro planner; artifacts in `runs/_monitor/0254ca7c/`
plus the actual run output at `C:\mnt\c\Users\kevin\Desktop\ollama_swarm\runs\debate-tcg\` (wrong path — see #PATH below).

- ✅ **CRITICAL — path mangling at the REST boundary.** Fixed in `1ec038d` — `normalizeWslPath()` utility at the route layer in `routes/swarm.ts` (both `/preflight` and `/start`). `/mnt/<drive>/<rest>` → `<DRIVE>:\<rest>` on Windows; no-op everywhere else. 13 unit tests. End-to-end verified via preflight: `/mnt/c/Users/.../runs` → `C:\Users\...\runs\debate-tcg`.

- ✅ **wallClockCapMs not enforced** — fixed. Root cause: post-audit reflection passes (stretch goals, memory distillation, design memory update) ran unconditionally even after the audit loop ended past the cap. Each is a 1-3 min planner prompt; on run 0254ca7c that pushed 14-min audit work to 19 min total. Fix gates each pass on `isOverWallClockCap()` (a non-mutating cap probe); when over, transcript surfaces a clear "cap exceeded; skipping bonus passes" message. Test suite (987/987) clean.

- **AUDIT: review all JSON formatting scenarios end-to-end.** Each `summary.kind` bubble (run_finished, seed_announce, verifier_verdict, agents_ready, council_draft, debate_turn, council_synthesis, stigmergy_report, mapreduce_synthesis, role_diff_synthesis, stretch_goals, debate_verdict, next_action_phase, worker_hunks) has its own renderer in `web/src/components/transcript/MessageBubble.tsx`. The fallback chain (worker_hunks-detection → AgentJsonBubble → JsonPrettyBubble → segmented-prose → CollapsibleBlock) also needs verification. **Trigger**: anytime; method = render each kind in browser, screenshot, compare to expected. Pairs with the SSE-streaming-collapsible regression below — likely some are broken by the same root cause (commit `0b3cda6` outer-div wrap).

- ✅ **#229 + #230 (2026-04-27 evening): server-side strip of XML pseudo-tool-call markers** in all 8 runners via `shared/stripAgentText.ts`. Closes the UI-noise + Phase 2 over-segmentation pieces. **NOT addressed** by this fix: when the model emits ONLY markers + nothing else (no JSON envelope), the planner parse correctly fails and the existing repair-prompt path fires. That is a model-behavior issue, not a parser issue. Discussion presets (council, debate-judge, role-diff, mapreduce, stigmergy, round-robin) all PASS overnight; blackboard + ow-deep still fail when the planner emits empty/garbage envelopes.

- **TOOL-CALL XML MARKERS leak into visible bubble + over-segment Phase 2.** Run 0fa1dd98 (with all 3 UI Phase fixes) showed glm-5.1 planner emitting `<read>src/foo</read>` / `<grep>pattern</grep>` / `<list>src/</list>` / `<glob>...</glob>` markers as raw text in the response. Each tool-call line is followed by `\n\n`, so Phase 2's content-boundary detector creates a separate micro-segment per call → 28 segments of one tool call each (run 0fa1dd98 first planner turn). **Two-layer fix needed**: (1) extract tool-call markers server-side at appendAgent (mirror extractThinkTags pattern — split into `toolCalls: string[]; finalText: string`); render as a collapsed `🔧 N tool calls` block similar to ThoughtsBlock; OR (2) if these ARE real SDK tool invocations being echoed in the text response, suppress them server-side entirely. (3) Independently, raise `MIN_SEGMENT_CHARS` from 20 to ~200, OR require content beyond just XML tool-call markers per segment. **Trigger**: anytime; pairs with Phase 1+2 of the UI coherent-fix.

- **THINK-TAG SUPPORT: model `<think>...</think>` content is rendered as raw text + leaks closing tags.** Modern reasoning models (deepseek, glm-5.1, gpt-o1, claude-extended-thinking) wrap their internal chain-of-thought in `<think>...</think>` markers. Every modern chat UI (opencode itself, ChatGPT, Claude.ai, Cursor) detects these markers and renders the thoughts collapsed-by-default with a "show thinking" expand affordance. Ours renders them as plain text — including stray `</think>` closing tags when the bubble starts mid-thought. **Fix direction**: at server-side `appendAgent` (or a new pre-render pass), detect `<think>...</think>` markers, split into `{ thoughts: string; finalText: string }` shape on the entry. MessageBubble renders thoughts as a `<details>`-style collapsed section by default, distinct from the final response. Pairs with the streaming-collapsibles fix below — the same content-boundary detection (`\n\n`, code-fence) extends naturally to `<think>` tag boundaries. **Trigger**: explicit "implement think-tag rendering" — affects every blackboard run + every preset using a reasoning model.

- **CONTRACT BUBBLE: "+N more" suffix is non-interactive.** When the planner emits `{missionStatement, criteria: [...]}`, the bubble shows first 3 criteria + literal "…+N more" string. To see criteria 4-N the user must click "VIEW JSON" and read raw JSON — no structured expand. **Fix direction**: either (a) add a dedicated `ContractBubble` component (matching the `RunFinishedGrid` / `DebateVerdictBubble` pattern) with its own expand state that renders all criteria in the structured layout, or (b) extend `AgentJsonBubble` with a "show full structured view" toggle that re-renders the envelope using kind-specific layout instead of dropping to raw JSON. Should pair with same fix applied to: auditor verdict envelopes (verdict count truncated similarly), worker hunks (when many hunks emitted), debate-judge verdicts. **Trigger**: anytime; UX win for every blackboard run.

- **STREAMING-COLLAPSIBLES: replace pause-based with content-based segmentation.** Investigation of run 897a3d8f confirmed: `useSegmentSplitter` uses 5s pause-detection, but the V2 OllamaClient direct path delivers text in 1-2 big batches (no 5s pauses) so 0 segment splits form. My commit `0b3cda6` outer-div wrap was NOT the cause — the data attrs work fine; segmentSplitPoints is just always empty.

  **Permanent fix (per Kevin's "what every modern chat UI does"):**
  1. Replace `useSegmentSplitterWithPoints` pause-detection with content-boundary detection (`\n\n` paragraph, code-fence open/close, markdown headers)
  2. Lower `STREAMING_THROTTLE_MS` 100 → 33 (30Hz) for smoother incremental render
  3. (Bonus) When the SDK path is used, treat `message.part.updated` events as intrinsic part boundaries — opencode already segments for us, V2 direct bypass loses that
  4. "Thinking" affordance visible while streaming even with no text yet

  **Trigger**: explicit "fix streaming UI" — affects every blackboard run + every preset's live transcript display.

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

### 2026-04-29 — multi-provider + scoreboard (#313–#320)

End-to-end multi-provider support (Ollama / Anthropic / OpenAI), cost cap, single-agent baseline, fixture framework, multi-seed scoreboard aggregator. CI gate for the same. 8 commits, 1209 server tests passing, both type-checks clean.

- ✅ `70b3bf4` — `#313` CI: add `--test-force-exit` so leaked handles don't wedge runner. Run #25113724147 hung 40 min after last PASS event because `--test-isolation=none` shares one process and accumulates `setInterval` leaks. Pair the flag with `--test-isolation=none` permanently.
- ✅ `fce5323` — `#314` Phase 1: opencode.json provider abstraction. Model strings now carry the provider in their prefix (`anthropic/claude-opus-4-7`, `openai/gpt-5`, unprefixed = ollama). `shared/src/providers.ts` is the single source of truth. 9 hardcoded `providerID: "ollama"` sites replaced with `toOpenCodeModelRef`. +13 tests.
- ✅ `c4496b6` — `#315` Phase 2: cost cap + `GET /api/providers`. `CostTracker.ts` per-(provider, model) pricing table. `RunConfig.maxCostUsd` field; `BlackboardRunner.checkAndApplyCaps` adds cost-cap line beside wall-clock and token-budget. /api/providers reports configured keys without echoing them. +10 tests.
- ✅ `5c1eb03` — `#316` Phase 3: capture token usage from paid-provider session events. `AgentManager.handleSessionEvent` parses `message.updated` events from non-Ollama providers and emits a UsageRecord into tokenTracker. Ollama path unchanged (proxy already records). +8 tests.
- ✅ `8f5f5f4` — `#317` Phase 4: setup form provider dropdown. 3-column Run grid (Rounds / Provider / Model). Provider `<select>` greys out Anthropic/OpenAI when keys are absent. Model autocomplete switches between dynamic (Ollama) and hardcoded (Claude / GPT). Max-cost field reveals only for paid providers.
- ✅ `7f3b0e6` — `#318` Phase 5: BaselineRunner — single agent, single prompt, single apply step. Honestly minimal so the scoreboard's "did the swarm beat doing it alone?" comparison is fair. Reuses worker prompt + parseWorkerResponse + v2Adapters. +7 tests.
- ✅ `efbe4d8` — `#319` Phase 6: scoreboard fixture framework + 3 starter tasks (fix-off-by-one / add-readme-section / rename-symbol). All deps-free, all verified-fail-on-broken-state. Pattern documented in `eval/fixtures/README.md`. 7 more fixtures queued.
- ✅ `baaf159` — `#320` Phase 7: multi-seed runner + scoreboard aggregator. `--seeds=N` flag (default 1, capped at 20). New `eval/aggregate.mjs` reads sweep results, computes per-cell median + IQR, writes `eval/RESULTS.md` + `eval/results.json`. Placeholder RESULTS.md ships pending first paid sweep. +6 tests.

Live verified via 90-second Playwright demo at `runs/_demo-providers-2026-04-29T17-04-18-794Z/`: provider dropdown, per-provider model autocomplete, cost-cap-field reveal, 0 console errors. Saved gotcha to memory: `feedback_ci_test_runner_flags.md`.

### 2026-04-29 (cont.) — backlog sweep + #231 RCA + fixture harness

Six follow-ups in one pass:

- ✅ `60d83b4` — Refresh active-work.md + README for multi-provider. Doc was 2 days stale.
- ✅ `59c5caa` — `#231` root-caused (training-prior, not opencode). Three actionable fixes ranked in active-work.md; recommended path: try Anthropic provider first.
- ✅ `b255630` — Ship the 7 queued Phase 6 fixtures (add-null-guard, extract-pure-helper, fix-failing-test, audit-console-logs, categorize-deps, multistep-add-script, multistep-config-then-test). Catalog now has 10 fixtures across code-modify / analysis / multi-step. All verify-fail-on-broken-state.
- ✅ `e6dfc55` — `scripts/audit-bubble-gallery.mjs` (D from backlog): headless Playwright probe of `?gallery=1` for regression checks. First run: 24 nodes / 18 distinct kinds / 0 console errors. Multi-provider work caused zero bubble regressions.
- ✅ `e0de102` — Add `--fixture-dir` mode to run-eval.mjs (unblocks F). Per-attempt fixture stage + git-init + file:// clone, post-run verify.mjs exec, score adjusted by ±50/-30. One sample catalog entry (fixture-fix-off-by-one) wired and smoke-tested locally.
- ✅ Audit findings: 5 of the 6 "pending UX items" in active-work.md were already shipped (Playwright-friendly transcripts, think-tag rendering, contract bubble structured expand, content-boundary segmentation, tool-call marker over-segmentation). Doc was tracking ghost work. Stale entries removed; the 6th (#231) is now researched + queued for Anthropic-key empirical check.

### 2026-04-27 evening — overnight validation tour

Full report at `runs_overnight/_OVERNIGHT-FINAL-REPORT.md`. 10 preset runs (8 + 2 bonus): 7 PASS / 3 FAIL. All FAILs are blackboard or ow-deep with empty/marker-only planner responses (model behavior issue, not parser issue).

- ✅ `4291b4c` — Validation tour: BubbleGallery fixture for `?gallery=1` (32 hand-crafted fixtures across every summary.kind variant)
- ✅ `2b4e871` — TodosBubble + quota_paused/resumed colored ribbons (#226 + #227 follow-ups from validation tour)
- ✅ `796d034` — `#228` strip unpaired `</think>` closer at head (RCA from preset 1 bonus catch — extends extractThinkTags 15→19 tests)
- ✅ `372809e` — `#229` server-side strip of XML pseudo-tool-call markers (new shared/extractToolCallMarkers + ToolCallsBlock + BlackboardRunner integration)
- ✅ `a8a66d4` — `#230` shared `stripAgentText` helper + CouncilRunner integration (refactor of #229 work into reusable helper)
- ✅ `9b9b0c4` — `#230` apply stripAgentText across remaining 6 runners (DebateJudge, MapReduce, OW, OW-Deep, RoundRobin, Stigmergy)

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
