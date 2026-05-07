# Project status — what's true right now

**Last updated:** 2026-05-04 (17 reliability helpers + 3-wave wiring + 6 cfg flags + per-run providerFailover + extended to all 11 runner-shaped call sites)
**Purpose:** single short doc you read first to understand current state without trawling through changelog or stale function references. If this doc disagrees with code, code wins — file an issue against this doc.

> **2026-04-29 — opencode subprocess removed (E3 Phases 1–5).** Every prompt
> now goes through a direct `SessionProvider` (Ollama / Anthropic / OpenAI)
> via `chatOnce`. Tool-using turns route through an in-process `ToolDispatcher`
> (read/grep/glob/list/bash with a hard allowlist). `Agent.client`, the
> `@opencode-ai/sdk` dep, the `PortAllocator`, and the spawn-subprocess code
> path are all gone. `OPENCODE_SERVER_PASSWORD` is still required at
> config-load time so existing `npm test` setups don't break, but it's
> otherwise unused.

---

## What ships today

**10 swarm presets** (one write-capable, nine discussion) + 1 baseline. Every preset honors the user directive except `stigmergy` (exploration is repo-driven). **Phase 1 + Phase 2 (2026-05-04)** added opt-in write capability for all discussion presets:

| Preset | Write-capable? | Honors directive? | Notes |
|---|---|---|---|
| `blackboard` | ✅ (native) | ✅ | planner + workers + auditor; tier ratchet; Aider-style hunks; pre-commit verify gate (`verifyCommand`) |
| `round-robin` | ⚡ (opt-in) | ✅ | Phase 1: `cfg.writeMode: "single"` → synthesizer produces hunks. Phase 2: `cfg.writeMode: "multi"` → vote reconciliation |
| `role-diff` | ⚡ (opt-in) | ✅ | Phase 1: specialist synthesis produces hunks. Phase 2: vote reconciliation |
| `council` | ⚡ (opt-in) | ✅ | Phase 1: council consensus produces hunks. Phase 2: per-round vote on overlapping hunks |
| `orchestrator-worker` (flat) | ⚡ (opt-in) | ✅ | Phase 1: lead synthesis produces hunks. Phase 2: sequential reconciliation (CAS on file hashes) |
| `orchestrator-worker-deep` | ⚡ (opt-in) | ✅ | Phase 1: multi-tier synthesis produces hunks. Phase 2: sequential reconciliation |
| `debate-judge` | ⚡ (opt-in) | ✅ | Phase 1: judge verdict produces hunks. Phase 2: judge picks winner's hunks |
| `map-reduce` | ⚡ (opt-in) | ✅ | Phase 1: reducer produces hunks. Phase 2: merge reconciliation (isolated slices) |
| `stigmergy` | ❌ | ❌ | pheromone-table + per-file annotations; exploration-focused (no action-driven writes) |
| `moa` | ⚡ (opt-in) | ✅ | Phase 1: aggregator produces hunks. Phase 2: aggregator picks best proposer's hunks |
| `baseline` | ✅ (native) | ✅ | single agent / single prompt / single apply step — eval-harness path, not in the form's normal preset list |

**Legend:** ✅ native write support | ⚡ opt-in via `cfg.writeMode: "single" | "multi"` + `cfg.writeModel` | ❌ no write support

Validation: tour v2 (2026-04-28) ran 9 sequentially with 8/9 self-terminating cleanly. MoA shipped 2026-05-01 with three layers of depth (initial → convergence detection → heterogeneous models per layer). Blackboard caps tightened by #304 (git committer identity) + #305 (cap watchdog 5s tick).

---

## Observability + reliability stack (2026-04-28)

| Feature | What it does | Code |
|---|---|---|
| Conformance gauge | LLM-as-judge polls every 90s; sparkline + numeric score in topbar | `server/src/services/ConformanceMonitor.ts` |
| Embedding drift gauge | Independent cosine-similarity signal; agreement hint vs LLM-judge | `server/src/services/EmbeddingDriftMonitor.ts` |
| Mid-run amend | User submits directive addendum; planner picks up at next cycle | `server/src/services/AmendmentsBuffer.ts` + `/api/swarm/amend` |
| Cost-share breakdown | Per-agent token shares + savings hint in run summary | `web/src/lib/costBreakdown.ts` |
| Eval harness | preset×task scoreboard | `eval/run-eval.mjs` + `eval/catalog.json` |
| Pre-commit verify gate | Worker hunks gated by user shell command (npm test, lint, etc.) | `WorkerPipeline.VerifyAdapter` |
| HITL nudge channel | `/api/swarm/amend` + topbar textarea | `IdentityStrip.AmendButton` |
| V2 event log | `/api/v2/event-log/runs` + UI EventLogPanel; infra-only filter | `EventLogReaderV2` |
| Run history (95+ runs) | History dropdown auto-scans `runs*/` at startup | `Orchestrator.scanForRunParents` |
| Model autocomplete | `/api/models` proxies Ollama tags into datalist on every model field | `useAvailableModels` hook |
| Cap watchdog (5s tick) | Wall-clock + commits + todos caps fire promptly during any phase | `BlackboardRunner.startCapWatchdog` (#305) |
| `runs/` retention | `node scripts/prune-runs.mjs --apply` keeps last N + last 7 days | `scripts/prune-runs.mjs` |
| CI | GitHub Actions runs npm test + type-check on push/PR | `.github/workflows/ci.yml` |

---

## V2 substrate — primary path

The V1 SDK loop (per-agent opencode subprocess + SSE chunked streaming) was retired 2026-04-28 alongside the V2 cutover commits. Current architecture:

| Component | File | Status |
|---|---|---|
| State machine | `shared/src/runStateMachine.ts` | primary |
| Observer | `server/src/swarm/blackboard/RunStateObserver.ts` | primary |
| TODO queue | `server/src/swarm/blackboard/TodoQueue.ts` (renamed from V2) | primary |
| Worker pipeline | `server/src/swarm/blackboard/WorkerPipeline.ts` (renamed) | primary; `VerifyAdapter` hook for pre-commit gates (#296) |
| Real fs+git adapters | `server/src/swarm/blackboard/v2Adapters.ts` | primary; #304 fixed inline committer identity |
| Ollama direct client | `server/src/services/OllamaClient.ts` | gated by `USE_OLLAMA_DIRECT=1` per-preset |
| Event log reader | `server/src/swarm/blackboard/EventLogReaderV2.ts` | primary; backs `/api/v2/event-log/runs` |
| `formatServerSummary` | `shared/src/formatServerSummary.ts` | shared between server + web |

**Test totals:** 2297 server tests passing / 0 failing as of 2026-05-06 (was 2271 → +26 across sibling-retry, symbol-grounding, planner fixes, UI fixes). Web type-check clean. Run `npm test` from the repo root — no env prefix required, the runner shim sets it.

---

## What landed 2026-05-04 (R1–R17 reliability layer, 4 commits)

A round of failure-mode resilience: 17 standalone pure helpers + three waves of wiring + six new env flags. Together they harden the swarm against quota walls, network blips, malformed JSON, disk pressure, memory pressure, browser disconnect, runaway loops, and unclean stops.

**The 17 helpers** (`server/src/swarm/`, all pure / synchronous):

| ID | Module | What it does |
|---|---|---|
| R1 | `providerFailover.ts` | `decideFailover(currentModel, classified, chain)` → swap / retry-same / give-up |
| R2 | `quotaProbeBackoff.ts` | exponential 1/2/4/8/16/30 min cap (replaces fixed 5-min `PAUSE_PROBE_INTERVAL_MS`) |
| R3 | `degradationFallback.ts` | `pickLocalFallback()` picks the largest local Ollama tag when cloud chain exhausts |
| R4 | `preflightCostProjector.ts` | `projectRunCost()` quadratic-growth estimate; `exceedsBudget()` vs `cfg.maxCostUsd` |
| R5 | `autoResumeDecision.ts` | auto-resume / notify-only / skip based on snapshot age + transcript length |
| R6 | `drainStopPolicy.ts` | first stop = drain, second within 5s = kill |
| R7 | `subscriberPausePolicy.ts` | pause when WS subscriber count drops to 0 |
| R8 | `cloneLock.ts` | cross-process `.lock` at `runs/<name>/.lock` with PID+host |
| R9 | `semanticLoopDetector.ts` | Jaccard pairwise sim over last K turns; halts after 3 consecutive detections |
| R10 | `modelHealthTracker.ts` | sliding-window success rate; degraded when <50% over ≥5 samples |
| R11 | `repairJson.ts` | strict → fence-strip → balanced-span → soft-repairs (trailing commas, smart quotes, missing braces) |
| R12 | `preflightDiskCheck.ts` | `fs.statfs` wrapper; default refuses runs with <2 GB free |
| R13 | `memoryPressure.ts` | heap-usage ratio → ok/throttle/pause |
| R14 | `memoryStorePruner.ts` | bounded by age (90d) + count (200) |
| R15 | `autoRca.ts` | primary cause + concrete recommendation per error category |
| R16 | `runHealthScore.ts` | 0–100 score with green/yellow/red buckets |
| R17 | `errorTaxonomy.ts` | 12-variant `ClassifiedError` (foundation for R1, R2, R10, R15) |

**Wiring waves** (4 commits):

- **Wave 1** — additive / replaces ad-hoc code, no flags: R11 swaps `transcriptSummary.tryParseJson` + `DebateJudgeRunner.parseLooseJson`; R2 wires the exponential probe into `BlackboardRunner`; R8 acquires `.lock` in `Orchestrator.start`, releases in every cleanup path; R12 + R4 preflight at `/api/swarm/start`; R14 prunes on every `appendMemoryEntry`; R15 + R16 populate new `RunSummary.rca` + `RunSummary.healthScore` fields.
- **Wave 2** — gated by new env flags default OFF: R17 errorTracker accumulates per-run `ClassifiedError` records; R6 drain-on-stop; R5 auto-resume on startup; R13 memory backpressure; R9 loop detector; R7 pause-on-WS-disconnect.
- **Wave 3** — provider-aware failover: new `promptWithFailover` wrapper layers R1 + R3 + R10. Drop-in for `promptWithRetry` with `FailoverState` + `FailoverConfig` parameters. Wired into `BlackboardRunner` with full per-run state + `/api/tags` discovery. Per-run `cfg.providerFailover` overrides env default.
- **Wave 4 (post-deferred)** — promotion + coverage: R7 + R13 + R9 lifted from signal-only to actual intervention (workers idle on `subscriberPaused` / `memoryPaused`; loop detector halts after 3 consecutive detections); `promptWithFailoverAuto` thin wrapper extends the failover chain to all 9 non-blackboard runners + 4 helpers (RoundRobin, Council, OW, OW-Deep, DebateJudge, MapReduce, MoA, Stigmergy + dynamicRoleCatalog, propositionDerive, qualityPasses, rubricPrePass). BaselineRunner uses `provider.chat()` directly and is the one remaining uncovered call path.

**New env flags** (`server/src/config.ts`, all default OFF):

- `SWARM_DRAIN_ON_STOP` — first /stop drains, second within 5s kills
- `SWARM_AUTO_RESUME` — scan + restart recoverable snapshots at startup
- `SWARM_MEMORY_BACKPRESSURE` — pause workers when heap >90% of `heapTotal`
- `SWARM_LOOP_DETECTION` — emit warnings + halt after 3 consecutive Jaccard-loop detections
- `SWARM_PAUSE_ON_DISCONNECT` — pause workers when WS subscriber count drops to 0
- `SWARM_PROVIDER_FAILOVER` — comma-separated chain (e.g. `"anthropic/claude-haiku-4-5,glm-5.1:cloud"`)
- `SWARM_DEGRADATION_FALLBACK` — when cloud chain exhausts, fall back to local Ollama tag
- `SWARM_DEGRADATION_PREFERRED` — comma-separated local tag preferences
- `SWARM_MODEL_HEALTH_SWAP` — proactive pre-flight swap when active model is degraded

**Per-run override:** `RunConfig.providerFailover` (string[], max 8 entries) wins over the env default. Surfaced as a "Failover chain" input in `SetupForm.tsx`.

**RunSummary additions:** every blackboard run now writes `rca: RcaReport` + `healthScore: RunHealthScore` fields. With all flags off and an empty failover chain, runtime behavior is unchanged.

---

## What landed 2026-05-04 earlier (every prior "deferred" item shipped + multi-tenant + doc cleanup)

A long session that closed every still-deferred item across the project. Net: **1209 → 1848 tests** (~+640), every preset's deferred lever shipped, multi-tenant runs end-to-end (server + client), 8 fully-shipped doc plans archived then deleted.

- **All 4 originally-deferred heavy substrate items shipped.** Parallel-clone-to-K-subdirs baseline (`BaselineSwarmHarness`); parallel debate streams (K full debates with cross-stream judge synthesis via `DebateStream`); in-flight parallel hypothesis (TodoQueue groupId + per-group AbortController + per-criterion grouping + 5-min conflict-deferral timeout); real adaptive worker pool (`AgentManager.killAgent` + hysteresis-aware `scaleUp`/`scaleDown`).
- **All secondary deferred items shipped.** Multi-language import graph (Rust + Go added to TS/JS+Python pipeline); test-scaffolding generator (Python pytest/unittest, Rust cargo-test, Go go-test added); blackboard auto-rollback verified already wired; MoA tool dispatch via `cfg.moaProposerTools`; map-reduce size-balanced LPT partition (`cfg.mapReducePartition`); council vote-reconcile policy (`cfg.councilReconcile`); stigmergy-on-blackboard worker dispatch (`cfg.stigmergyOnBlackboard`); recovery listing (`/api/swarm/recoverable-runs` + `findRecoverableRuns`); per-prompt model auto-routing (`cfg.dynamicModelRoute` + `dynamicModelRoute.ts` helpers); auto-route recommendations from cost breakdown; env-tunable runtime caps (`SWARM_WALL_CLOCK_CAP_MIN`, `SWARM_COMMITS_CAP`, `SWARM_TODOS_CAP`).
- **Auto-resume of recovered runs.** Snapshot schema bumped v1 → v2 with embedded `runConfig`; `Orchestrator.recoverRun` + `POST /api/swarm/recover/:runId` reconstruct cfg + restart on the existing clone.
- **Multi-tenant runs end-to-end.** Server: `SwarmEvent.runId` stamping + per-runId WS subscriber filter (`/ws?runId=X`) + `Map<runId, ActiveRun>` refactor + concurrency cap (`SWARM_MAX_CONCURRENT_RUNS` env, default 4) + per-run REST routes (`/api/swarm/runs/:id/{status,say,stop}`) + `/api/swarm/active-runs` listing. Client: react-router with `/runs/:runId` deep-link routes; `ActiveRunsPanel` polls `/api/swarm/active-runs` + lets the user navigate or stop any run; `useRunScopedWebSocket` for components that want a per-run WS feed; SwarmView's stop/say buttons target the per-run REST when `runId` is known.
- **Per-run zustand factory.** `createSwarmStore()` returns a fresh store per `/runs/:runId` route; `SwarmStoreProvider` wraps the per-run subtree + opens its own per-run WS + REST hydration; the existing `useSwarm(selector)` hook reads from context-or-singleton so all 30+ components keep working unchanged. `useSwarmSocket` no-ops when a Provider is mounted to avoid double-dispatch.
- **Doc cleanup pass.** 8 fully-shipped design plans archived then deleted (their content was duplicated by the actual code + git log); `subtask-migration-plan.md` renamed to `-postmortem.md` since "plan" misled; `ARCHITECTURE-V2.md` updated with "V2 IS the current architecture" preamble; `V2-STEP-6C.md` flipped to PAUSED; `SCOREBOARD-PUBLISHING-PLAN.md` retired (Kevin: laptop hardware too slow + no Anthropic budget). `eval/aggregate.mjs` now bakes methodology + caveats into every generated `RESULTS.md`. Doc tree: 29 → 20 .md files.

## What landed 2026-05-03

- **Ollama Cloud as a 4th distinct provider.** `shared/src/providers.ts` adds `"ollama-cloud"` to the Provider union with a `(?::|-)cloud$` regex detector that catches both `glm-5.1:cloud` and `gemma4:31b-cloud` shapes. The Provider Tab control renders four side-by-side tabs; selecting Ollama Cloud filters the model dropdown to a 21-entry catalog sourced from `ollama.com/search?c=cloud`. Runtime routing collapses `ollama-cloud` → `ollama` in `toOpenCodeModelRef` and `pickProvider` (the local install proxies `:cloud` models to ollama.com transparently). New `OLLAMA_API_KEY` env var is informational — Ollama Cloud is always usable when the local install has an account configured.
- **Setup form UX overhaul.** Sticky Start CTA at the bottom (no scroll-to-find), first-time starter chips with a "Don't show again" dismiss, collapsed-by-default Topology grid with "Edit per-agent" reveal, inline DirectiveBadge (only renders for non-honored presets), auto-resize User directive textarea, recently-used runs chip row with localStorage persistence, inline preflight that detects existing clones and offers "Resume run." See `scripts/verify-setup-ux.mjs` for the Playwright probe that captures all 9 states.
- **All 9 active discussion presets now honor user directives.** Round-robin rotates Critic/Synthesizer/Gap-finder/Builder dispositions framed around the directive; role-diff with a directive flips into a build team producing `deliverable.md`; map-reduce mappers find directive-relevant evidence; council's `MY POSITION` blocks anchor on the directive; OW/OW-Deep decompose the directive into worker subtasks; debate-judge auto-derives a debatable proposition from it. Only `stigmergy` ignores it (exploration is repo-driven).
- **Multi-provider live model discovery.** `/api/models?provider=anthropic|openai` hits `/v1/models` directly with the API key, server-side cached for 24h. Ollama Cloud falls back to the curated catalog. The `ModelSelect` dropdown surfaces source provenance ("9 live models from Anthropic API" vs "21 models from the Ollama Cloud catalog").

## What landed 2026-05-01 (31 commits)

A long day. Headline categories:

- **Two load-bearing bug fixes:** provider streaming chunk-drop (`eff8c4f`) — paid-provider responses were silently truncated to the first SSE batch; dotenv root-path (`4190afe`) — paid keys never loaded.
- **5 features × 3 layers each:** constrained decoding (#86 → #91 → #96), self-consistency hunks (#87 → #92 → #97), Mixture of Agents preset (#88 → #93 → #98), time-travel replay UI (#90 → #94 → #99), SWE-Bench Lite integration (#89 → #95 → #100). Each shipped first-cut, deeper, then deepest.
- **3 UI bug fixes:** stable streaming-bubble order (`f8ed703`), MoA emits agent_state (`f8ed703`), finalized chat bubble collapses all segments (`faa601f`).
- **Scoreboard publishing prep:** plan doc (`db28481`), MoA per-layer model CLI flags + tour script (`96484e1`), catalog reframe with corrected MoA scope (`fb41336`).
- **Doc-rot pass + memory cleanup:** ghost items pruned, scoreboard plan corrected for MoA discussion-only nature.

## Recent fixes worth knowing about

- **Sibling-retry model failover (2026-05-06)** — when planner, contract, or auditor JSON parsing fails after repair, the runner retries once with a sibling model via `siblingModelFor()` lookup. All five retry paths (3 planner, 1 contract, 1 auditor) emit reverse `model_shift` in `finally` blocks so the UI doesn't permanently show the fallback model.
- **Symbol-grounding strips hallucinations (2026-05-06)** — `checkExpectedSymbols()` now strips invalid `expectedSymbols` rather than dropping the entire todo. A todo with valid `expectedFiles` but hallucinated symbol references keeps its files and loses only the symbols.
- **Planner read-only todo ban (2026-05-06)** — hard rule 5a in the planner prompt explicitly bans read-only TODOs ("read X", "analyze Y"). Workers decline these, wasting cycles.
- **Client-side bare todo object recognition (2026-05-06)** — `summarizeAgentJson.ts` now recognizes a single `{description, expectedFiles}` object (not wrapped in an array) from planner output, rendering it as a TodosBubble instead of raw JSON.
- **UI sidebar update on run completion (2026-05-06)** — two fixes: `AgentManager.killAll()` now broadcasts agent "stopped" states before setting `killed=true`; Zustand `setPhase()` clears `agents: {}` on terminal phase so `SidebarSummaryAgents` renders from summary.
- **`eff8c4f` (2026-05-01)** — provider streaming chunk-drop bug in `AnthropicProvider` + `OpenAIProvider`. `Promise.race([reader.read(), timeout])` was abandoning in-flight reads on every 200ms tick; abandoned reads silently consumed subsequent chunks, truncating responses to whatever fit in the first SSE batch. Pre-fix: Claude Sonnet returned `"Here"` for `"Count from 1 to 10"` (28 tokens generated, 4 captured). Fix keeps one in-flight read across iterations. Regression test in `5c13b10` uses 250ms-delay async streams to surface the bug if reintroduced.
- **`4190afe` (2026-05-01)** — latent dotenv path bug. `server/src/config.ts` did `import "dotenv/config"` which resolved relative to `process.cwd()`. `dev.mjs` runs the server with `cwd=server/`, so the canonical repo-root `.env` was silently ignored. Paid keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) would never load. Replaced with explicit `dotenv.config({ path: <repoRoot>/.env })`.
- **`f3d0aeb` (2026-05-01)** — V2 Step 6c first thin slice: `GET /api/v2/event-log/runs/:runId` per-run record replay endpoint + 5 tests. Pure backend addition; unblocks every UI cutover step that follows. Full remaining cutover scoped in `docs/V2-STEP-6C.md`.
- **`f8ed703` + `faa601f` (2026-05-01)** — three UI bugs: streaming bubbles violently swapped positions (sort-by-recency caused re-render thrash; fixed by sorting by stable agentIndex); MoA agent panel sidebar showed spawn-time state forever (MoaRunner had zero `emitAgentState` calls; the other 7 discussion runners had 9-13 each); finalized chat bubble's last segment "escaped" the collapsible bracket as raw prose (fixed by uniformly collapsing all segments).
- **`bb0c509`** — proxy always terminates rewritten `OLLAMA_BASE_URL` with `/v1`. Pre-fix, env var without `/v1` silently broke every opencode prompt with empty responses (404 on `/chat/completions`).
- **`189ca05`** — wall-clock 4-min "absolute turn cap" replaced with SSE-aware liveness watchdog (`sseAwareTurnWatchdog.ts`). Aborts on 90s SSE silence OR 30-min hard ceiling. Long-tail latency that's still producing tokens isn't killed.
- **`cfee38d`** — `agents_ready` structured summary; expandable per-agent grid in UI showing port, role, model, sessionId, warmup elapsed.

> **Strategic note (2026-05-01):** the project's value prop is **open-weights multi-agent parallelism** (N Ollama-served models in parallel against one repo, each playing a different role). Multi-provider abstractions stay — bug-fixes that improve paid paths still ship — but don't expand multi-provider feature work for its own sake. Future scoreboard work should compare Ollama models against each other across presets, not Claude vs baseline. See `project_value_prop_open_weights_first.md` in memory.

---

## Where things live

```
shared/src/                                  pure types + parsers (server + web both consume)
  runStateMachine.ts                         V2 state machine reducer
  formatServerSummary.ts                     one-line summary helper
  transcriptEntrySummary.ts                  TranscriptEntrySummary discriminated union
  summarizeAgentJson.ts, extractJson.ts      shared JSON parsers

server/src/
  index.ts                                   bootstrap, broadcaster, eventLogger, route mount
  config.ts                                  zod-validated env loading
  services/
    AgentManager.ts                          in-process Agent records, warmup, killAll (no subprocess post-E3)
    Orchestrator.ts                          runner factory + status getter
    OllamaClient.ts                          legacy direct chunked-HTTP path; still used by some discussion runners
    RepoService.ts                           git clone (opencode.json synthesis deleted in E3 Phase 5)
    ollamaProxy.ts                           local proxy at :11533 for token tracking + quota detection
    Session.ts                               in-process session shim (replaces opencode session.create)
  providers/                                  E3: SessionProvider abstraction
    pickProvider.ts                          factory: Ollama | Anthropic | OpenAI by model prefix
    OllamaProvider.ts, AnthropicProvider.ts, OpenAIProvider.ts
  swarm/
    chatOnce.ts                              one-shot prompt helper (used everywhere)
  tools/
    ToolDispatcher.ts                        in-process read/grep/glob/list/bash with allowlist
  routes/
    swarm.ts                                 POST /api/swarm/start /stop /drain /say
    v2.ts                                    GET /api/v2/status /event-log/runs
    dev.ts                                   POST /api/dev/board-poke (test scaffolding)
  swarm/
    promptWithRetry.ts                       shared retry wrapper (used by every runner)
    sseAwareTurnWatchdog.ts                  V2 SSE-liveness-aware turn cap
    agentsReadySummary.ts                    helper for the agents_ready summary kind
    {RoundRobin,Council,RoleDiff,...}Runner.ts   one runner per preset
    BaselineSwarmHarness.ts                  T-Item-1: K parallel BaselineRunners → winner-pick → promote (when cfg.baselineAttempts > 1)
    DebateStream.ts                          T-Item-2: per-stream state container for parallel debate streams
    dynamicModelRoute.ts                     T-Item-AutoRoute: role→model picker for cfg.dynamicModelRoute
    councilReconcile.ts                      T-Item-CouncilRec: vote tally + parser for cfg.councilReconcile
    blackboard/
      BlackboardRunner.ts                    blackboard preset orchestration (~4,500 LOC; +T-Item-3 hypothesis groups, +T-Item-StigBb file commit counts, +T-Item-4 adaptive scaleUp/Down)
      plannerRunner.ts                       planner + replanner agent with sibling-retry
      contractBuilder.ts                     first-pass contract builder with sibling-retry
      auditorRunner.ts                        auditor agent with sibling-retry
      contextBuilders.ts                      prompt/context assembly for all blackboard agents
      BlackboardRunnerConstants.ts            sibling-model lookup + shared constants
      TodoQueue.ts                           FIFO substrate + groupId/listGroup/markGroupSettled/dequeueByScore
      WorkerPipeline.ts                      apply-and-commit pipeline
      v2Adapters.ts                          real fs+git adapters
      RunStateObserver.ts                    state-machine observer
      EventLogReaderV2.ts                    JSONL event log parser
      hypothesisGrouping.ts                  T-Item-3 + T-Item-HypTimeout: hypothesis-tag detection + conflict-detection deferral
      summary.ts                             RunSummary type + buildSummary
      ARCHITECTURE.md                        code-near design doc — read before editing this dir
      prompts/                               planner / worker / replanner / auditor prompt builders + zod parsers
      reflectionPasses.ts                    stretch-goal + memory-distillation post-passes

web/src/
  main.tsx                                   BrowserRouter wrapper (T-Item-PerRunStore)
  App.tsx                                    Routes: / + /runs/:runId; AppMain renders the run view
  state/
    store.ts                                 zustand factory + Context-aware useSwarm (T-Item-PerRunStore)
    SwarmStoreProvider.tsx                   per-run Provider: fresh store + per-runId WS + REST hydration
    applyEvent.ts                            shared SwarmEvent → SwarmStore dispatcher (singleton + per-run reuse)
  hooks/
    useSwarmSocket.ts                        WS singleton; no-ops when SwarmStoreContext is mounted
    useRunScopedWebSocket.ts                 per-runId WS for components that want a scoped feed
  components/
    SwarmView.tsx, Transcript.tsx, BoardView.tsx, ...
    ActiveRunsPanel.tsx                      polls /api/swarm/active-runs every 5s; per-row view+stop buttons
    transcript/
      MessageBubble.tsx                      per-entry render dispatcher (system/user/agent)
      AgentJsonBubble, WorkerHunksBubble, RunFinishedGrid, ...   per-envelope bubble renderers
      DebateVerdictBubble, formatServerSummary.ts (shim)
    EventLogPanel.tsx                        V2 event-log dropdown in header
```

---

## Active design constraints (don't accidentally break these)

- **No more opencode subprocess.** E3 Phase 5 removed it. Every prompt goes through `pickProvider` → `chatOnce`. Don't reintroduce subprocess spawning without checking ADR 001 (which is now historical).
- **Don't rotate the planner role.** Single-session context continuity matters — see `feedback_blackboard_planner_design.md` in memory.
- **Workers return JSON envelopes only** (no tool grants). Planner/auditor get the in-process `ToolDispatcher` (read/grep/glob/list/bash) — not the legacy opencode permission system.
- **Discussion presets are write-capable when `cfg.writeMode` is set.** Blackboard's workers commit natively; all others produce hunks when writeMode is `single` or `multi`. Only `stigmergy` remains read-only.
- **`npm test` works from any shell, any cwd** as of `c27f857` (2026-05-01). The runner shim (`server/scripts/run-tests.mjs`) sets `OPENCODE_SERVER_PASSWORD=test-only` if not already set; `config.ts` still validates the env var even though no subprocess uses it.
- **`/mnt/c` is the project root** (WSL → Windows). npm install hazards from WSL — see `feedback_wsl_windows_esbuild` in memory.

---

## Where to look next

- **Day-1 essentials for an agent picking up this repo:** `docs/AGENT-GUIDE.md`
- **Persistent TODO list across sessions:** `docs/active-work.md` (queued / in-flight / recently shipped)
- **Architecture decisions ("why this and not that"):** `docs/decisions/` (4 active ADRs: per-agent subprocess [historical], hunk format, write-capable preset boundary, V2 parallel-track rollout. ADR 005 [keep opencode] superseded 2026-04-29 by E3 Phases 1–5; superseded body retained for archaeology.)
- **Code-near architecture for blackboard:** `server/src/swarm/blackboard/ARCHITECTURE.md`
- **V2 rewrite roadmap + status:** `docs/ARCHITECTURE-V2.md`
- **Per-preset design notes:** `docs/swarm-patterns.md`
- **What's a deliberate trade-off vs. a bug:** `docs/known-limitations.md`
- **Long-horizon north star:** `docs/autonomous-productivity.md`
- **Detailed change history:** `git log` (the 206KB phase-journal is at `docs/archive/blackboard-changelog.md` — useful for narrative archaeology but git log is authoritative)
- **Per-agent feedback / preferences:** `~/.claude/projects/-mnt-c-Users-kevin-Desktop-ollama-swarm/memory/MEMORY.md` (read first; it's loaded into every session's context)
