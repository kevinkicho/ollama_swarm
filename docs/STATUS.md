# Project status — what's true right now

**Last updated:** 2026-04-27
**Purpose:** single short doc you read first to understand current state without trawling through changelog or stale function references. If this doc disagrees with code, code wins — file an issue against this doc.

---

## What ships today

8 swarm presets (one write-capable, seven discussion):

| Preset | Write-capable? | Notes |
|---|---|---|
| `blackboard` | ✅ | planner + workers + auditor; tier ratchet; Aider-style hunks |
| `round-robin` | ❌ | shared transcript, no role differentiation |
| `role-diff` | ❌ | per-agent role bias (Architect / Tester / etc.) |
| `council` | ❌ | private draft → reveal → converge; early-stop on convergence |
| `orchestrator-worker` (flat) | ❌ | lead dispatches subtasks |
| `orchestrator-worker-deep` | ❌ | flat + mid-tier lead |
| `debate-judge` | ❌ (default) | exactly 3 agents Pro/Con/Judge; `executeNextAction: true` opts into a write phase |
| `map-reduce` | ❌ | reducer + N mappers; convergence on consecutive empty cycles |
| `stigmergy` | ❌ | pheromone-table + report-out |

Validation: 7/7 SDK-path presets passed clean (0 empty / 0 stale-idle / 0 SSE-abort) on 2026-04-27 against `kevinkicho/debate-tcg` with the post-2026-04-27 fix set.

---

## V2 architectural rewrite — substrate complete, integration partial

See `docs/ARCHITECTURE-V2.md` for full spec. Status:

| Substrate | File | Tests | Integration |
|---|---|---|---|
| State machine | `shared/src/runStateMachine.ts` | 33 | wired into `BlackboardRunner` via `RunStateObserver` (parallel-track + `checkPhase` at every `setPhase`) |
| Observer | `server/src/swarm/blackboard/RunStateObserver.ts` | 15 | live in `BlackboardRunner`; `v2State` ships in `RunSummary` |
| TODO queue | `server/src/swarm/blackboard/TodoQueueV2.ts` | 28 | mirror via `onBoardEvent`; `v2QueueState` ships in `RunSummary` |
| Worker pipeline | `server/src/swarm/blackboard/WorkerPipelineV2.ts` | 11 | gated by `USE_WORKER_PIPELINE_V2=1`; `executeWorkerTodoV2` validated 4 commits |
| Real fs+git adapters | `server/src/swarm/blackboard/v2Adapters.ts` | 10 | live |
| Ollama direct client | `server/src/services/OllamaClient.ts` | 6 | gated by `USE_OLLAMA_DIRECT=1`; only `BlackboardRunner` uses it |
| Event log reader | `server/src/swarm/blackboard/EventLogReaderV2.ts` | 18 | `/api/v2/event-log/runs` + UI `EventLogPanel` ship the read path |
| `formatServerSummary` | `shared/src/formatServerSummary.ts` | 26 | shared between server + web |

Total: **972 tests passing**.

To opt the blackboard preset onto V2 paths: `USE_OLLAMA_DIRECT=1 USE_WORKER_PIPELINE_V2=1` env vars on dev server start.

---

## Recent fixes worth knowing about

- **`bb0c509`** — proxy always terminates rewritten `OLLAMA_BASE_URL` with `/v1`. Pre-fix, env var without `/v1` silently broke every opencode prompt with empty responses (404 on `/chat/completions`).
- **`18a7749`** — `streamPrompt` filters stale `session.idle` from prior prompt's tail. Pre-fix, the next prompt's stream resolved with empty text when warmup's idle event arrived <100ms later.
- **`189ca05`** — wall-clock 4-min "absolute turn cap" replaced with SSE-aware liveness watchdog (`sseAwareTurnWatchdog.ts`). Aborts on 90s SSE silence OR 30-min hard ceiling. Long-tail latency that's still producing tokens isn't killed.
- **`cfee38d`** — `agents_ready` structured summary; expandable per-agent grid in UI showing port, role, model, sessionId, warmup elapsed.

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
    AgentManager.ts                          spawn opencode subprocesses, SSE event subscription, streamPrompt
    Orchestrator.ts                          runner factory + status getter
    OllamaClient.ts                          V2 direct chunked-HTTP path
    RepoService.ts                           git clone, opencode.json synthesis
    ollamaProxy.ts                           local proxy at :11533 for token tracking + quota detection
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
      BlackboardRunner.ts                    blackboard preset orchestration (~3,400 LOC)
      Board.ts                               V1 todo board (claim/CAS/lock); V2 mirrors via TodoQueueV2
      TodoQueueV2.ts                         V2 FIFO substrate
      WorkerPipelineV2.ts                    V2 apply-and-commit pipeline
      v2Adapters.ts                          real fs+git adapters for V2
      RunStateObserver.ts                    parallel-track V2 observer
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

- **One opencode subprocess per agent.** Intentional isolation — confirmed by Kevin 2026-04-23. Don't propose collapsing.
- **Don't rotate the planner role.** Single-session context continuity matters — see `feedback_blackboard_planner_design.md` in memory.
- **Workers MUST stay on `swarm` agent profile** (no read tools — they return JSON envelopes only). Planner/auditor are a separate question (see known-limitations.md).
- **Discussion presets read-only via `swarm-read` profile.** Only blackboard's workers can write.
- **Test command requires `OPENCODE_SERVER_PASSWORD=test-only` prefix** — fixed in commit `3ad6869`. Without it, tests that transitively import config.ts fail at zod validation.
- **`/mnt/c` is the project root** (WSL → Windows). npm install hazards from WSL — see `feedback_wsl_windows_esbuild` in memory.

---

## Where to look next

- **Code-near architecture for blackboard:** `server/src/swarm/blackboard/ARCHITECTURE.md`
- **V2 rewrite roadmap + status:** `docs/ARCHITECTURE-V2.md`
- **Per-preset design notes:** `docs/swarm-patterns.md`
- **What's a deliberate trade-off vs. a bug:** `docs/known-limitations.md`
- **Long-horizon north star:** `docs/autonomous-productivity.md`
- **Detailed change history:** `git log` (the 206KB phase-journal is at `docs/archive/blackboard-changelog.md` — useful for narrative archaeology but git log is authoritative)
- **Per-agent feedback / preferences:** `~/.claude/projects/-mnt-c-Users-kevin-Desktop-ollama-swarm/memory/MEMORY.md` (read first; it's loaded into every session's context)
