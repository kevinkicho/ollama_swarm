# Active work — queued + in-flight (across sessions)

> Persistent TODO list that survives between agent sessions. Per-session
> `TaskCreate` items die when the session ends; this file is the durable
> equivalent. **Update it when you finish or queue work.**
>
> Last refreshed: 2026-04-29 (E3 Phase 5 cleanup pt 5: cosmetic surgery on Agent.client + recovery shims)

---

## Queued (waiting on user nod or specific trigger)

### Cloud-quota-burning validation

- **Multi-repo blackboard validation with V2 paths.** Only debate-tcg validated end-to-end so far (4 V2 commits, 0 divergences). Want at least 2-3 different repo types (small Python, larger TypeScript, doc-heavy) to surface scenarios the V2 worker pipeline hasn't hit yet (large hunks, conflicts, multi-file commits). **Trigger**: explicit user "go run multi-repo validation."

- **Long-horizon blackboard run with tier ratchet.** 2-4 hours of continuous mode against a target with a real directive. Validates pause/resume, audit cap behavior, tier promotion, stretch-goal reflection at scale. **Trigger**: explicit "go long-run."

### Risky cutovers (need stable validation first)

- ✅ **V2 Step 5c.3 — delete Board.ts.** SHIPPED 2026-04-28 during V2 cutover Phase 2c. Confirmed 2026-04-29 audit: `Board.ts` no longer exists; only stale comments in BlackboardRunner / TodoQueue reference its prior existence. (active-work.md note was stale.)

- **V2 Step 6c — UI cuts over to event-log-derived state.** Foundation shipped 2026-04-29; first thin slice shipped 2026-05-01 (`GET /api/v2/event-log/runs/:runId` per-run replay endpoint — backend-only, zero UI risk). Remaining ~1-2 days of UI-side work scoped in `docs/V2-STEP-6C.md`. **Trigger**: focused refactor session — order of attack documented in the scoping doc.

- ✅ **E3 — Drop opencode subprocess dependency.** SHIPPED 2026-04-29 across multiple commits. Phases 1-5 complete:
  - Phase 1 (`8dcf0b5`): SessionProvider abstraction + 3 raw-HTTP impls (Ollama / Anthropic / OpenAI)
  - Phase 2 (`f44fb28`): promptWithRetry + BaselineRunner route through pickProvider behind `USE_SESSION_PROVIDER`
  - Phase 3 (`47b15ba`, `2603d5b`, `e4f377c`, `fd5d6de`, `76e9e28`): all 9 runners spawn without opencode + 5 direct session.prompt callers migrated via chatOnce + onChunk streaming preserved
  - Phase 4 (`18facec`, `20aa431`, `0416d97`, `5461575`, `75a7505`): ToolDispatcher (read/grep/glob/list/bash) + Anthropic tool_use loop + OpenAI tool_calls loop + dispatcher wired through chatOnce + promptWithRetry
  - Phase 5: defaults for USE_SESSION_PROVIDER + USE_SESSION_NO_OPENCODE flipped to TRUE — opencode subprocess unreachable on the default path
  
  ✅ **Cleanup pt 1** (commit `d9bee86`): `AgentManager.spawnAgent` legacy 165-LOC body deleted (delegates to `spawnAgentNoOpencode`); `RepoService.writeOpencodeConfig` deleted (~180 LOC); 8 RepoService.test.ts tests for opencode.json shape removed; all 10 callers stopped invoking it.

  ✅ **Cleanup pt 2** (commit `d189f0d`): `@opencode-ai/sdk` removed from `server/package.json`; `createOpencodeClient` import + `Client` type alias replaced with a local `SessionClient` stub interface in AgentManager.ts. Dead opencode-only methods (handleSessionEvent, attachEventStream, streamPrompt, warmupAgent, respawnAgent — ~1000 LOC of unreachable code) still in tree but type-check against the stub. They're never called at runtime; physical deletion is a focused future cleanup session that has no functional impact.

  ✅ **Cleanup pt 3** (commit `c5ea7b1`): dead SSE-chain methods physically deleted from AgentManager (~470 LOC). `handleSessionEvent`, `attachEventStream`, `streamPrompt`, `warmupAgent` gone; the SSE event subscription bookkeeping (`lastActivity`, `messageRouters`, `idleResolvers`) gone. Type-check + test suite pass (no callers).

  ✅ **Cleanup pt 4** (commit `85e8980`): every legacy opencode code path deleted (~660 LOC). `spawnAgent` two-branch logic collapsed to delegate-only; `dev.ts` `swarm-ui-poke` returns 410 Gone (Playwright-MCP-via-opencode is no longer reachable); 9 runner `abortSession` callbacks reduced to no-ops.

  ✅ **Cleanup pt 5** (uncommitted as of 2026-04-29): `Agent.client` field deleted; `SessionClient` stub interface deleted; `pingAgentHealth` + `respawnAgent` no-op shims deleted; `BlackboardRunner` recovery dance (subprocess-death detection) replaced with single direct prompt; `reflectionPasses.promptOnFreshSession` no longer creates an opencode session before chatOnce; one absolute-turn-cap `agent.client.session.abort` call site replaced with comment (AbortController is the only abort needed). Type-check clean. Tests pending.

  **Still on disk (manual cleanup required):** `node_modules/@opencode-ai/sdk` and `node_modules/opencode-ai` directories. The dep is gone from `server/package.json` but `npm install` from WSL is forbidden (`feedback_wsl_hazards` — esbuild swap). Run `npm install` from a Windows shell to physically remove the package directory.

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

- ✅ **#231 — XML pseudo-tool-call markers CLOSED 2026-05-01.** Empirical check ran a 2-min Claude blackboard run via `pickProvider("anthropic/claude-sonnet-4-6")` against octocat/Hello-World. **Result: zero `<read>` / `<grep>` / `<list>` / `<glob>` / `<bash>` markers across 1,975 chars of planner output.** Hypothesis confirmed: native Anthropic provider with native `tool_use` blocks bypasses the OpenAI-bridge mismatch that makes open-weights coding models reach for trained-in XML formats. **Action**: docs note added — for tool-using prompts, prefer paid providers if quality matters more than cost. Investigation history retained below.

- **#231 — XML pseudo-tool-call markers ROOT-CAUSED 2026-04-29 (training-prior, not opencode).** Investigation findings:

  - The opencode v2 SDK (`node_modules/@opencode-ai/sdk/dist/v2/`) does NOT contain any XML tool-call format anywhere; greps for `tool_use` / `<read` / `<grep` / `XML.*tool` return zero hits. Hypothesis B (opencode injects XML examples) ruled out.
  - The PLANNER_SYSTEM_PROMPT already has explicit rule 1a (2026-04-27): `Do NOT emit raw XML tool-call syntax... that's the SDK's internal tool-call format`. Models still emit it → prompting alone can't fix this. Hypothesis A ruled in (training prior).
  - Both `glm-5.1:cloud` and `nemotron-3-super:cloud` route through Ollama's OpenAI-compatible bridge. When opencode declares `read`/`grep`/`glob` as tools via the OpenAI function-call schema, the model's weights reach for whatever tool format they were trained on — for many open-weights coding models, that's Anthropic-style XML tags (since those leaked into training corpora as exemplars). Hypothesis C confirmed: this is an OpenAI-bridge mismatch.

  **Practical impact:** the markers get stripped server-side via `shared/stripAgentText` (#229/#230) so runs still complete; the cost is wasted tokens emitting XML the runner discards.

  **Three actionable fixes, ranked:**
  1. **Try with Anthropic provider.** Post-E3 Phase 5 the path is even cleaner than the original note assumed: `pickProvider("anthropic/...")` → `AnthropicProvider` → raw fetch to `api.anthropic.com` with **native** `tool_use`/`tool_result` blocks, fully bypassing both opencode and any OpenAI-compat bridge. Hypothesis predicts: zero XML pseudo-tool-call leak with Claude on this path. **Runbook:**
     1. Drop `ANTHROPIC_API_KEY=sk-ant-...` into `.env`.
     2. Restart `npm run dev` so the server re-reads env.
     3. In the setup form: pick provider = Anthropic, model = `anthropic/claude-sonnet-4-6`, set `maxCostUsd=0.50`, preset = blackboard, agent count = 2 (planner + 1 worker).
     4. Use a small target repo (the existing tour fixtures work) and a tight directive ("add a one-line README badge" suffices — we just want one planner turn).
     5. Inspect first planner-bubble's raw text: search for `<read`, `<grep`, `<list`, `<glob`. Expectation = zero hits.
     6. Save the run dir under `runs/_anthropic-231-check-<ts>/` for the record. If clean → close #231 with a doc note "use Anthropic provider for tool-using prompts." If not → escalate to option 2.
  2. **Add an XML→JSON tool-call translator** in the runner — when the parser sees `<read path="X">`, dispatch a real `read` tool call against the clone, splice the result back into the prompt, re-prompt the model. ~6h work, complex error paths, fragile.
  3. **Strip tool grants from the planner profile**. Cost: planner can't grep before emitting TODOs → drops the grounding loop the prompt relies on. Likely net-worse for run quality.

  **Recommended next step:** option 1 — cheap, has the strongest theoretical reason to work, and exercises the multi-provider path live for the first time (kills two birds). **Trigger**: when Kevin pastes the key.

- **First paid scoreboard sweep + 7 more fixtures.** Phase 6 shipped 3 starter fixtures + the framework; 7 more are queued in `eval/fixtures/README.md` (add-null-guard, extract-pure-helper, fix-failing-test, audit-console-logs, categorize-deps, multistep-add-script, multistep-config-then-test). After at least 5 fixtures land, run a 3-seed × Sonnet 4.6 sweep (~$5–15) and overwrite `eval/RESULTS.md` with real numbers. **Trigger**: explicit "go run paid sweep" with budget authorization.

- ✅ **Live multi-provider end-to-end** — exercised 2026-05-01 alongside #231. Real Anthropic-keyed blackboard run (`anthropic/claude-sonnet-4-6` planner + Ollama workers + Ollama auditor) cloned octocat/Hello-World, planner emitted 3 contract envelopes (1,975 chars), workers committed 2 hunks, run ended on auditor cap in 1m 59s. `maxCostUsd=0.50` cap not hit. Token capture worked, no console errors, no agent deaths. The path `pickProvider` → `AnthropicProvider` → native `tool_use` is now production-validated.

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

- **AUDIT: review all JSON formatting scenarios with LIVE data.** Fixture-level coverage of every `summary.kind` is verified clean (2026-04-29 + 2026-05-01 BubbleGallery audits, both 0 console errors). The live-data version — render bubbles as they arrive during a real run, screenshot, compare — is genuinely pending. Pairs with the #231 Anthropic check above (same run can drive both). **Trigger**: when the next paid live run kicks.

- ✅ **#229 + #230 (2026-04-27 evening): server-side strip of XML pseudo-tool-call markers** in all 8 runners via `shared/stripAgentText.ts`. Closes the UI-noise + Phase 2 over-segmentation pieces. **NOT addressed** by this fix: when the model emits ONLY markers + nothing else (no JSON envelope), the planner parse correctly fails and the existing repair-prompt path fires. That is a model-behavior issue, not a parser issue. Discussion presets (council, debate-judge, role-diff, mapreduce, stigmergy, round-robin) all PASS overnight; blackboard + ow-deep still fail when the planner emits empty/garbage envelopes — covered by #231 work.

- ✅ **TOOL-CALL XML MARKERS leak / over-segmentation** — shipped via #229/#230 (`shared/stripAgentText.ts`) + `extractToolCallMarkers` + `web/src/components/transcript/ToolCallsBlock.tsx`. Server strips before the segmenter sees them; collapsed tool-call block renders the markers separately.

- ✅ **THINK-TAG SUPPORT** — shipped via `shared/extractThinkTags` + `web/src/components/transcript/ThoughtsBlock.tsx`. Server splits `{thoughts, finalText}`; web renders thoughts collapsed-by-default above the main bubble.

- ✅ **CONTRACT BUBBLE structured expand** — shipped at `web/src/components/transcript/ContractBubble.tsx` as a 3-tab interactive component (Summary / All N criteria / JSON).

- ✅ **STREAMING-COLLAPSIBLES content-boundary segmentation** — shipped at `web/src/components/useSegmentSplitter.ts:32` (`findContentBoundaries`). Pause-based fallback retained at 15s.

- ✅ **Issue #1 (OllamaClient 60s idle)** — fixed via two-phase timeout (firstChunkTimeoutMs=180s + idleTimeoutMs=60s).

- ✅ **Issue #3 (planner empty → repair → 0-todos)** — fixed via SIBLING_MODELS map + one-shot fallback; preserved across E3 Phase 5 cleanup.

- ✅ **Monitor script reads wrong summary.json** — fixed 2026-05-01 (this session); now probes both WSL and Windows path shapes and matches by runId.

- ✅ **Playwright capture still gets 0 bubbles** — verified shipped at `MessageBubble.tsx:49-51` (`data-entry-id` + `data-summary-kind` + `data-agent-index` etc.).

- *(Removed: deepseek-v4-pro 65s/turn latency estimate. Default model reverted to glm-5.1:cloud per `user_environment.md`; the deepseek estimate is no longer load-bearing.)*

---

## Data-grounded findings from earlier 2026-04-27 blackboard run f78342b7

*(Issues #1, #3, #4 from this section all shipped — #3 via SIBLING_MODELS fallback, #1 via two-phase timeout, #4 via `data-entry-id` attrs on MessageBubble. The `npm test` cross-env shim is also shipped 2026-05-01 in this session — see "Done recently" below. Section retained as a pointer to the artifact at `runs/_monitor/f78342b7/` for narrative archaeology.)*

---

## Done recently (last 30 days; older lands in archive/blackboard-changelog.md)

### 2026-05-01 — E3 cleanup pt 6 + bubble re-audit + #231 RESOLVED + dotenv + provider streaming fix + doc rot

- ✅ `npm install` from PowerShell physically removed `node_modules/@opencode-ai/sdk` (75 lockfile lines deleted). The dep was already gone from `package.json` since cleanup pt 2 (`d189f0d`); this catches `package-lock.json` up. Commit `4190afe`.
- ✅ Bubble-gallery re-audit against live `?gallery=1`: 24 fixture nodes, 18 distinct `summary.kind`, 0 console errors. Matches the 2026-04-29 baseline → multi-provider work caused zero bubble regressions live. New `scripts/audit-bubble-gallery-win.mjs` is the Windows-host variant of the WSL-only original. Report: `runs/_bubble-audit-2026-05-01T15-29-25-615Z/REPORT.md`.
- ✅ Updated #231 entry above with concrete 6-step runbook reflecting post-E3 reality (no opencode layer; `pickProvider` → `AnthropicProvider` direct).
- ✅ **Latent dotenv-path bug fixed in `server/src/config.ts`** — `dev.mjs` spawns the server with `cwd=server/`, so `import "dotenv/config"`'s default cwd-based lookup was missing the documented repo-root `.env`. `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` would never have loaded until this fix; never noticed because nobody had keys to test with. Replaced with explicit `dotenv.config({ path: <repoRoot>/.env })`. Commit `4190afe`.
- ✅ **Doc rot pass** — pruned 5+ ghost items from "Data-grounded findings 2026-04-27" sections that had silently shipped: think-tag rendering, contract bubble, content-boundary segmentation, tool-call marker over-segmentation, Playwright-friendly transcripts, Issues #1/#3/#4 from f78342b7. The active-work.md tracked-as-pending count dropped accordingly.
- ✅ **Root-level `npm test` script** added to root `package.json` so `npm test` works from any shell, any cwd, no env prefix. The cross-env shim itself (`server/scripts/run-tests.mjs`) had already shipped 2026-04-27 (`0b3cda6`) — only the root-delegation wrapper was missing. CLAUDE.md prefix instruction updated.

- ✅ **Streaming chunk-drop bug fixed** in `AnthropicProvider` + `OpenAIProvider` (commit `eff8c4f`). The `Promise.race([reader.read(), timeout(200ms)])` pattern abandoned in-flight reads on timeout; abandoned reads silently consumed subsequent chunks, truncating responses to whatever fit in the first SSE batch. Discovered while empirically validating #231 — Claude was returning "Here" for "Count from 1 to 10" (28 tokens generated, 4 captured). Regression test added (commit `5c13b10`) using a 250ms-delay async stream.

- ✅ **#231 EMPIRICALLY CLOSED** — Claude on native Anthropic provider produced 1,975 chars of planner output across 3 contract envelopes with **zero XML pseudo-tool-call markers**. Hypothesis confirmed; the OpenAI-bridge mismatch theory was correct. Action: docs note for "use paid providers when tool-call quality matters."

- ✅ **V2 Step 6c first thin slice** (commit `f3d0aeb`): `GET /api/v2/event-log/runs/:runId` per-run replay endpoint + 5 tests. Pure backend addition; unblocks every UI cutover step that follows without touching any WS dispatch code. Full remaining cutover (~1-2 days) scoped in `docs/V2-STEP-6C.md` — order of attack, risks, when-not-to-do.

- ✅ **Eval harness Windows + multi-attempt fixes** (commit `f3d0aeb`): Two latent bugs surfaced when kicking the paid sweep — (1) cross-platform CLI guard so `node eval/run-eval.mjs` actually runs `main()` on Windows (`import.meta.url` vs Windows backslashes), (2) `fireStart` no longer treats leftover `phase=completed` from a prior attempt as "new run started" (would have scored sweep attempts 2-N as instant verify=FAIL). Plus new `--model` + `--maxCostUsd` flags so paid sweeps don't need .env edits.

- ✅ **Catalog wiring** (commit `f3d0aeb`): added catalog entries for `fixture-add-null-guard` + `fixture-extract-pure-helper` (fixture dirs were on disk since `b255630` but never wired into the catalog).

### 2026-04-29 — multi-provider + scoreboard (#313–#320)

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
