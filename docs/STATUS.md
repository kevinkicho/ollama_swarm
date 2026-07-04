# Project status — what's true right now

**Last updated:** 2026-07-04 (Brain-as-OS + persistent FAB Brain chat + per-run brain history + /brain/suggest + transcript injection + docs consolidation)
**Purpose:** single short doc you read first to understand current state without trawling through changelog or stale function references. If this doc disagrees with code, code wins — file an issue against this doc.

> **2026-04-29 — opencode subprocess removed (E3 Phases 1–5).** Every prompt
> now goes through a direct `SessionProvider` (Ollama / Anthropic / OpenAI)
> via `chatOnce`. Tool-using turns route through an in-process `ToolDispatcher`
> (read/grep/glob/list/bash with a hard allowlist). `Agent.client`, the
> `@opencode-ai/sdk` dep, the `PortAllocator`, and the spawn-subprocess code
> path are all gone. `OPENCODE_SERVER_PASSWORD` is still required at
> config-load time so existing `npm test` setups don't break, but it's
> otherwise unused.
>
> **2026-07 — Legacy agent memory consolidated:** `.opencode/session-checkpoint.md` (and `.opencode/`) superseded and removed after consolidation of historical notes (council refactor, test snapshots, old LOCs) into `docs/STATUS.md`, `docs/AGENT-GUIDE.md`, and `README.md`. `opencode.json` now points at current docs. Old `terminals/*.txt` are runtime logs (not guidance).

---

## What ships today (high level)

The app is a **Brain-as-OS for concurrent swarm orchestration**:

- **Brain-as-OS layer** (under blackboard): real-time monitoring, run analysis & final reports, cross-run knowledge (librarian), run provisioning, health tracking. Brain acts as master-admin for initializing, starting, finishing, reviewing records and analyzing runs. System self-patching / self-upgrader removed.
- **Brain during live runs (FAB + chat + suggest)**: Floating fixed 🧠 "Brain" pill (bottom-right in SystemWrapper, shown for active runs) opens modal running `BrainStartChat` with runContext (transcript summary via formatServerSummary + board todos + phase + cfg). Chat uses `/brain/chat` (with runContext prompt augmentation). History saved per-run via store + `/brain/chat-history` + RunStatePersister + summary recovery. `/brain/suggest` calls `brainService.injectSuggestion` which appends system + emits `brain_suggestion` transcript kind (rendered in MessageBubble). Proactive inject wired in Council stuck cycles + adaptive watchdog stalls.
- **Concurrent multi-swarm support**: multiple independent runs in parallel (`/runs/:runId` routing, ActiveRunsPanel, per-run WebSocket/REST, concurrency cap). Brain and UI manage them at system level.
- **System UI**: `SystemWrapper` with persistent sidebar, floating Brain FAB, BrainProposalsPanel, BrainActivityPanel, SystemStatus, PatchMonitor, RunQueue, topbar stats/health. Transcript filter defaults to "key" (avoids information bombardment).
- **Recent major UI work**: full viewport layout hardening, sticky elements, scrolling fixes; dedicated Brain chat + suggest flow.
- **12 presets** with the existing write-mode story (blackboard native writes; others opt-in via `writeMode`).

**12 swarm presets** (blackboard + 10 discussion/pipeline variants + baseline). Opt-in write capability for discussion presets:

| Preset | Maturity | Write-capable? | Notes |
|---|---|---|---|
| `blackboard` | production | ✅ (native) | planner + workers + auditor; tier ratchet; Aider-style hunks; pre-commit verify gate (`verifyCommand`). Most tested preset with deepest maturity. |
| `round-robin` | production | ⚡ (opt-in) | Rotating Critic/Synthesizer/Gap-finder/Builder dispositions framed around directive. `cfg.writeMode: "single"` → synthesizer produces hunks; `"multi"` → vote reconciliation. |
| `council` | production | ✅ (native) | **3-phase autonomous cycle:** Phase 1 (Analysis): N agents debate and synthesize consensus. Phase 2 (Execution): ALL agents become workers, produce hunks via pipeline. Phase 3 (Audit): ALL agents inspect changes. Cycles repeat in autonomous mode (`rounds: 0`). Retry-on-failure with error feedback. **Architecture:** `CouncilRunner.ts` orchestrates; `councilDecisions.ts` handles todo extraction (`extractActionableTodos`, `extractTodosFromAudit`) with path grounding — legacy Gate 1/3/4 decision helpers were removed. `councilExecution.ts` handles parallel worker execution; `councilAudit.ts` handles audit phase; `councilSynthesis.ts` handles synthesis; `councilDeliverable.ts` handles deliverables; `councilVoteReconcile.ts` handles vote reconciliation. **Blackboard infrastructure:** Uses TodoQueue, ExitContract, hunk-based editing, replanner, path grounding, and tier ratchet. |
| `orchestrator-worker` (flat) | production | ⚡ (opt-in) | Lead decomposes directive into subtasks for workers. Phase 1: lead synthesis; Phase 2: sequential reconciliation (CAS on file hashes). |
| `role-diff` | beta | ⚡ (opt-in) | Specialist role assignment per agent with diff-based deliverable. Phase 1: specialist synthesis; Phase 2: vote reconciliation. |
| `debate-judge` | beta | ⚡ (opt-in) | PRO/CON/JUDGE debate structure. Phase 1: judge verdict produces hunks; Phase 2: judge picks winner's hunks. |
| `map-reduce` | beta | ⚡ (opt-in) | Mappers find directive-relevant evidence → reducer synthesizes. Phase 1: reducer hunks; Phase 2: merge reconciliation (isolated slices). Partition-dependent quality. |
| `orchestrator-worker-deep` | needs-validation | ⚡ (opt-in) | 3-tier: orchestrator → mid-leads → workers. Phase 1: multi-tier synthesis; Phase 2: sequential reconciliation. **Known issue:** validation tour hit model-drift failures — some models produce XML pseudo-tool-calls under structured-output pressure in deep chains. |
| `stigmergy` | exploration | ❌ | Pheromone-table + per-file annotations. **Read-only by design** — exploration mode, no write pipeline. Pheromone heatmap feeds blackboard workers when `cfg.stigmergyOnBlackboard` is on. |
| `moa` | beta | ⚡ (opt-in) | Mixture of Agents: proposers → aggregators, three layers of depth. Phase 1: aggregator hunks; Phase 2: aggregator picks best proposer's hunks. **Shipped 2026-05-01 in a single day; less polish than older presets.** |
| `baseline` | production | ✅ (native) | single agent / single prompt / single apply step — eval-harness path, not in the form's normal preset list |
| `pipeline` | beta | ⚡ (opt-in) | Chains sub-runs with transcript/deliverable piping. Default phases: Explore → Decompose → Validate. Each phase's output feeds the next. |

All presets honor the user directive except `stigmergy` (exploration is repo-driven by design).

**Research / internet-heavy use cases**: Prefer `webTools: true` + `plannerTools: true` with council, map-reduce, moa, role-diff, pipeline, or hybrid council→blackboard. See `docs/swarm-patterns.md` "Research Workflows" for recommended combinations and concrete configs (e.g. superconductor literature analysis).

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
| Brain-as-OS | proposals, analysis, run provisioning, health monitoring, during-run chat (FAB), proactive suggestions via injectSuggestion | `brainOverseer/*`, `brainService.ts`, `/brain/*` routes, SystemWrapper + BrainStartChat + transcript MessageBubble (brain_suggestion kind) |
| Concurrent runs + Active Runs UI | multi-tenant, per-run routing, ActiveRunsPanel | Orchestrator + `/api/swarm/active-runs` + deep links |
| V2 event log | `/api/v2/event-log/runs` + UI EventLogPanel; infra-only filter | `EventLogReaderV2` |
| Run history (95+ runs) | History dropdown auto-scans `runs*/` at startup | `Orchestrator.scanForRunParents` |
| Model autocomplete | `/api/models` proxies Ollama tags into datalist on every model field | `useAvailableModels` hook |
| Agent tools | Local-only (read/grep/glob/list + restricted bash). No web/internet tools for agents. | `ToolDispatcher`, profiles in `promptWithRetry` / `roles.ts` |
| Cap watchdog (5s tick) | Wall-clock + commits + todos caps fire promptly during any phase | `BlackboardRunner.startCapWatchdog` (#305) |
| `runs/` retention | `node scripts/prune-runs.mjs --apply` keeps last N + last 7 days | `scripts/prune-runs.mjs` |
| `logs/` retention | `node scripts/prune-logs.mjs --apply` (current.jsonl rotations + per-run debug*.jsonl) | `scripts/prune-logs.mjs` (new) |
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

**Test totals:** Run `npm test` from the repo root (the shim sets any required env). Current count is the source of truth in CI.

---

## Historical milestones (see git log for full detail)

> Long detailed history from 2026-05 and earlier has been condensed. 
> Current high-level state is at the top of this file. `git log` + `docs/archive/` contain the archaeology.

Key periods:
- **2026-05 reliability layer (R1–R17)**: 17 pure helpers for failover, backoff, loop detection, memory pressure, repair, caps, health scores, etc. Many now wired with env flags (default OFF). Full list lives in `server/src/swarm/`.
- **Multi-tenant / concurrent runs**: Per-run isolation, `ActiveRun` ownership, `/runs/:runId` routing, ActiveRunsPanel, concurrency cap. Shipped end-to-end.
- **Preset write capability + directive honoring**: Most presets now support opt-in writes; nearly all honor user directives.
- **E3 (Apr 29)**: Complete removal of per-agent opencode subprocesses.

For the full narrative, use `git log --oneline` or the archived blackboard-changelog. Focus agents on the "What ships today" and active constraints sections above.

> **Strategic note:** the project's value prop is **open-weights multi-agent parallelism** + Brain-as-OS on top. Multi-provider support exists for flexibility but is not the primary focus. See `active-work.md` for current Brain work.

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
  providers/                                  E3: SessionProvider abstraction (5 providers)
    pickProvider.ts                          factory: Ollama | Anthropic | OpenAI | OpenCode by model prefix
    OllamaProvider.ts, AnthropicProvider.ts, OpenAIProvider.ts, OpenCodeProvider.ts
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
    BaselineSwarmHarness.ts                  (baseline attempts / parallel harness)
    DebateStream.ts                          (parallel debate support)
    dynamicModelRoute.ts                     (dynamic model routing per role)
    councilReconcile.ts                      (council vote reconciliation)
    blackboard/
      BlackboardRunner.ts                    blackboard preset orchestration (planner + workers + auditor)
      brainOverseer/                         Brain-as-OS (analysis, proposals, selfUpgrader, provisioner, health)
      plannerRunner.ts / auditorRunner.ts    planner + dedicated auditor with tools + sibling retry
      WorkerPipeline.ts + v2Adapters.ts      hunk apply + CAS commit + verify gate
      TodoQueue.ts + RunStateObserver.ts     core substrate for blackboard state machine
      ... (see server/src/swarm/blackboard/ARCHITECTURE.md)

web/src/
  main.tsx                                   BrowserRouter + per-run routing
  App.tsx                                    Routes: / + /runs/:runId
  state/
    store.ts                                 zustand factory + per-run SwarmStoreProvider
    SwarmStoreProvider.tsx                   per-run Provider: fresh store + per-runId WS + REST hydration
    applyEvent.ts                            shared SwarmEvent → SwarmStore dispatcher (singleton + per-run reuse)
  hooks/
    useSwarmSocket.ts                        WS singleton; no-ops when SwarmStoreContext is mounted
    useRunScopedWebSocket.ts                 per-runId WS for components that want a scoped feed
  components/
    SystemWrapper.tsx                        root wrapper with persistent brain/system sidebar + panels
    SwarmView.tsx, Transcript.tsx, BoardView.tsx, ...
    BrainProposalsPanel.tsx, BrainActivityPanel.tsx, SystemStatusPanel.tsx ...
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
- **Don't rotate the planner role.** Single-session context continuity matters (see history in blackboard feedback notes).
- **Workers return JSON envelopes only** (no tool grants). Planner/auditor get the in-process `ToolDispatcher` (read/grep/glob/list/bash) — not the legacy opencode permission system.
- **Discussion presets are write-capable when `cfg.writeMode` is set.** Blackboard's workers commit natively; all others produce hunks when writeMode is `single` or `multi`. Only `stigmergy` remains read-only.
- **`npm test` works from any shell, any cwd** as of `c27f857` (2026-05-01). The runner shim (`server/scripts/run-tests.mjs`) sets `OPENCODE_SERVER_PASSWORD=test-only` if not already set; `config.ts` still validates the env var even though no subprocess uses it.
- **`/mnt/c` is the project root** (WSL → Windows). npm install hazards from WSL (esbuild binary swap). See WSL notes in AGENT-GUIDE.

---

## Transcript and hunk display pipeline (2026-05-17)

Every LLM response flows through this chain to become visible in the UI:

```
Agent raw text
  │
  ▼
server: stripAgentText()        → extracts <think>, XML tool call markers
server: summarizeAgentResponse() → builds entry.summary (kind: worker_hunks, worker_skip, etc.)
server: emit(transcript_append) → pushes entry to WebSocket
  │
  ▼
broadcast.ts                     → JSON.stringify → ws.send()
  │
  ▼
usewarmSocket.ts                 → JSON.parse → applyEventToStore()
  │
  ▼
store.ts: appendEntry()          → dedup by ID, copy streaming split points → transcript[]
  │
  ▼
Transcript.tsx                   → .map(e => <MessageBubble entry={e} />)
  │
  ▼
MessageBubble.tsx                → dispatches by entry.role + entry.summary.kind
  │
  ├── system → SystemBubble      → RUN-START divider, failover badge, quota pause/resume
  ├── user   → CollapsibleBlock  → chat messages
  └── agent  → AgentBubble       → dispatches by summary.kind across 13 sub-bubbles
```

**21 `TranscriptEntrySummary.kind` values** drive the renderer. See `shared/src/transcriptEntrySummary.ts` for the full union.

**Worker hunks** specifically: `WorkerHunksBubble` (collapsed by default) shows a summary line + +/- line counts. Click "Show diff" to expand per-hunk diff panes:
- Replace → amber header, rose bg for removed text, emerald bg for replacement
- Create/append → emerald header and bg
- First 12 lines shown, "show all N lines" to expand

**13 files** in `web/src/components/transcript/` implement all bubble types: `MessageBubble`, `WorkerHunksBubble`, `JsonBubbles`, `RunFinishedGrid`, `StreamingDock`, `TodosBubble`, `DebateVerdictBubble`, `ContractBubble`, `AuditorVerdictBubble`, `ThoughtsBlock`, `ToolCallsBlock`, `RunStartDivider`, `formatServerSummary`.

**Key design decisions:**
- Server is the authoritative summarizer — client-side JSON parsing is a fallback only
- Streaming dock holds live text until `transcript_append` replaces it
- Worker hunks collapsed by default to prevent visual overwhelm in busy runs
- ID-based dedup prevents double-rendering on reconnect

## Where to look next (current reading order for agents)

1. `docs/STATUS.md` — this file (current high-level + file map)
2. `docs/active-work.md` — persistent cross-session TODOs + what Brain/OS work has shipped
3. `docs/ARCHITECTURE-VISION.md` — original north-star (many phases now real)
4. `docs/AGENT-GUIDE.md` — operational commands + gotchas
5. `docs/known-limitations.md` — deliberate trade-offs
6. `server/src/swarm/blackboard/ARCHITECTURE.md` — deep blackboard substrate
7. `docs/decisions/` + git log for history

**Key current concepts:** Brain-as-OS (monitoring + self-upgrade + provisioning), concurrent runs (`/runs/:runId`, ActiveRunsPanel), SystemWrapper UI, 12 presets.
