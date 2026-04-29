# Project status — what's true right now

**Last updated:** 2026-04-28
**Purpose:** single short doc you read first to understand current state without trawling through changelog or stale function references. If this doc disagrees with code, code wins — file an issue against this doc.

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

**Test totals:** 1100+ server tests passing (was 972 at V2 cutover; +130 from this session's observability + RCA + lifecycle work).

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

- **Day-1 essentials for an agent picking up this repo:** `docs/AGENT-GUIDE.md`
- **Persistent TODO list across sessions:** `docs/active-work.md` (queued / in-flight / recently shipped)
- **Architecture decisions ("why this and not that"):** `docs/decisions/` (5 ADRs covering per-agent subprocess, hunk format, write-capable preset boundary, V2 parallel-track rollout, keeping opencode)
- **Code-near architecture for blackboard:** `server/src/swarm/blackboard/ARCHITECTURE.md`
- **V2 rewrite roadmap + status:** `docs/ARCHITECTURE-V2.md`
- **Per-preset design notes:** `docs/swarm-patterns.md`
- **What's a deliberate trade-off vs. a bug:** `docs/known-limitations.md`
- **Long-horizon north star:** `docs/autonomous-productivity.md`
- **Detailed change history:** `git log` (the 206KB phase-journal is at `docs/archive/blackboard-changelog.md` — useful for narrative archaeology but git log is authoritative)
- **Per-agent feedback / preferences:** `~/.claude/projects/-mnt-c-Users-kevin-Desktop-ollama-swarm/memory/MEMORY.md` (read first; it's loaded into every session's context)
