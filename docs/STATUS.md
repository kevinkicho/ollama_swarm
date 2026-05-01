# Project status — what's true right now

**Last updated:** 2026-05-01
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

**9 swarm presets** (one write-capable, eight discussion):

| Preset | Write-capable? | Notes |
|---|---|---|
| `blackboard` | ✅ | planner + workers + auditor; tier ratchet; Aider-style hunks; pre-commit verify gate (`verifyCommand`) |
| `round-robin` | ❌ | shared transcript, no role differentiation |
| `role-diff` | ❌ | per-agent role bias (Architect / Tester / etc.) |
| `council` | ❌ | private draft → reveal → converge; early-stop on convergence |
| `orchestrator-worker` (flat) | ❌ | lead dispatches subtasks |
| `orchestrator-worker-deep` | ❌ | flat + mid-tier lead (≥4 agents) |
| `debate-judge` | ❌ (default) | exactly 3 agents Pro/Con/Judge; `executeNextAction: true` opts into a write phase |
| `map-reduce` | ❌ | reducer + N mappers; convergence on consecutive empty cycles |
| `stigmergy` | ❌ | pheromone-table + per-file annotations; structured-card bubbles (#303) |

Validation: tour v2 (2026-04-28) ran all 9 sequentially. 8/9 self-terminated cleanly; blackboard hit safety net at 20m due to two pre-fix bugs (#304 git committer identity + #305 cap watchdog overshoot). Both blockers patched + tested; fresh blackboard validation pending in #306.

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

**Test totals:** 1209 server tests passing as of 2026-04-29; 2026-05-01 added 7 (5 v2 route + 2 streaming-regression). Run `npm test` from the repo root — no env prefix required, the runner shim sets it.

---

## Recent fixes worth knowing about

- **`eff8c4f` (2026-05-01)** — provider streaming chunk-drop bug in `AnthropicProvider` + `OpenAIProvider`. `Promise.race([reader.read(), timeout])` was abandoning in-flight reads on every 200ms tick; abandoned reads silently consumed subsequent chunks, truncating responses to whatever fit in the first SSE batch. Pre-fix: Claude Sonnet returned `"Here"` for `"Count from 1 to 10"` (28 tokens generated, 4 captured). Fix keeps one in-flight read across iterations. Regression test in `5c13b10` uses 250ms-delay async streams to surface the bug if reintroduced.
- **`4190afe` (2026-05-01)** — latent dotenv path bug. `server/src/config.ts` did `import "dotenv/config"` which resolved relative to `process.cwd()`. `dev.mjs` runs the server with `cwd=server/`, so the canonical repo-root `.env` was silently ignored. Paid keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) would never load. Replaced with explicit `dotenv.config({ path: <repoRoot>/.env })`.
- **`f3d0aeb` (2026-05-01)** — V2 Step 6c first thin slice: `GET /api/v2/event-log/runs/:runId` per-run record replay endpoint + 5 tests. Pure backend addition; unblocks every UI cutover step that follows. Full remaining cutover scoped in `docs/V2-STEP-6C.md`.
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
    blackboard/
      BlackboardRunner.ts                    blackboard preset orchestration (~4,200 LOC)
      TodoQueue.ts                           FIFO substrate (renamed from TodoQueueV2; Board.ts deleted 2026-04-28)
      WorkerPipeline.ts                      apply-and-commit pipeline (renamed from WorkerPipelineV2)
      v2Adapters.ts                          real fs+git adapters
      RunStateObserver.ts                    state-machine observer
      EventLogReaderV2.ts                    JSONL event log parser
      summary.ts                             RunSummary type + buildSummary
      ARCHITECTURE.md                        code-near design doc — read before editing this dir
      prompts/                               planner / worker / replanner / auditor prompt builders + zod parsers
      reflectionPasses.ts                    stretch-goal + memory-distillation post-passes

web/src/
  App.tsx                                    top-level router
  state/store.ts                             Zustand store: phase, agents, transcript, streaming, runHistory
  hooks/useSwarmSocket.ts                    WS singleton + auto-reconnect dispatcher
  components/
    SwarmView.tsx, Transcript.tsx, BoardView.tsx, ...
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
- **Discussion presets are read-only.** Only blackboard's workers commit to the clone.
- **`npm test` works from any shell, any cwd** as of `c27f857` (2026-05-01). The runner shim (`server/scripts/run-tests.mjs`) sets `OPENCODE_SERVER_PASSWORD=test-only` if not already set; `config.ts` still validates the env var even though no subprocess uses it.
- **`/mnt/c` is the project root** (WSL → Windows). npm install hazards from WSL — see `feedback_wsl_windows_esbuild` in memory.

---

## Where to look next

- **Day-1 essentials for an agent picking up this repo:** `docs/AGENT-GUIDE.md`
- **Persistent TODO list across sessions:** `docs/active-work.md` (queued / in-flight / recently shipped)
- **Architecture decisions ("why this and not that"):** `docs/decisions/` (4 active ADRs: per-agent subprocess [historical], hunk format, write-capable preset boundary, V2 parallel-track rollout. ADR 005 [keep opencode] superseded 2026-04-29 by E3 Phases 1–5.)
- **Code-near architecture for blackboard:** `server/src/swarm/blackboard/ARCHITECTURE.md`
- **V2 rewrite roadmap + status:** `docs/ARCHITECTURE-V2.md`
- **Per-preset design notes:** `docs/swarm-patterns.md`
- **What's a deliberate trade-off vs. a bug:** `docs/known-limitations.md`
- **Long-horizon north star:** `docs/autonomous-productivity.md`
- **Detailed change history:** `git log` (the 206KB phase-journal is at `docs/archive/blackboard-changelog.md` — useful for narrative archaeology but git log is authoritative)
- **Per-agent feedback / preferences:** `~/.claude/projects/-mnt-c-Users-kevin-Desktop-ollama-swarm/memory/MEMORY.md` (read first; it's loaded into every session's context)
