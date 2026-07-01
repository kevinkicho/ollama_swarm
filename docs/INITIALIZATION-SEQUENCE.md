# Server Initialization Sequence

> Step-by-step walkthrough of how the ollama_swarm server boots up.

---

## Phase 1: Module Loading (synchronous)

**File:** `server/src/index.ts`

| Step | What happens | File/Function |
|------|-------------|---------------|
| 1 | Configure undici HTTP dispatcher | `configureHttpDispatcher()` |
| 2 | Load config from env vars | `config.ts` → `config` object |
| 3 | Import all services | AgentManager, Orchestrator, Broadcaster, etc. |

---

## Phase 2: Express App Setup (synchronous)

| Step | What happens | File/Function |
|------|-------------|---------------|
| 4 | Create Express app | `express()` |
| 5 | Add middleware stack | securityHeaders, apiVersion, cors, compression, requestLogger |
| 6 | Set WS auth token | `randomUUID()` → cookie |
| 7 | Parse JSON bodies | `express.json({ limit: "1mb" })` |
| 8 | Create HTTP server | `http.createServer(app)` |
| 9 | Create WebSocket server | `new WebSocketServer({ noServer: true })` |

---

## Phase 3: Core Services (synchronous)

| Step | What happens | File/Function |
|------|-------------|---------------|
| 10 | Create event logger | `createEventLogger({ logDir })` |
| 11 | Create broadcaster | `new Broadcaster(eventLogger)` |
| 12 | Create PID tracker | `new AgentPidTracker(repoRoot)` |
| 13 | Create AgentManager | `new AgentManager(emit, broadcast, log, pidTracker)` |
| 14 | Create RepoService | `new RepoService()` |
| 15 | Create Orchestrator | `new Orchestrator({ manager, repos, emit, ... })` |

---

## Phase 4: Ollama Proxy (conditional, before listen)

| Step | What happens | File/Function |
|------|-------------|---------------|
| 16 | Check if proxy enabled | `config.OLLAMA_PROXY_PORT > 0` |
| 17 | Start proxy server | `startOllamaProxy({ listenPort, upstreamUrl })` |
| 18 | Rewrite config URL | `config.OLLAMA_BASE_URL = proxyUrlWithSuffix` |

---

## Phase 5: Cleanup (async, before listen)

| Step | What happens | File/Function |
|------|-------------|---------------|
| 19 | Reclaim orphaned PIDs | `reclaimOrphans(repoRoot)` |
| 20 | Reclaim stale clone locks | `reclaimStaleLocks(knownParents)` |
| 21 | Startup health check | `startupHealthCheck(port, logsDir)` |

---

## Phase 6: Server Listen + Post-Start (async)

| Step | What happens | File/Function |
|------|-------------|---------------|
| 22 | Start HTTP server | `server.listen(port, "0.0.0.0", callback)` |
| 23 | Log startup info | console.log with port, model, event log path |
| 24 | Auto-resume runs | `autoResumeOnStartup()` (if enabled) |

---

## Phase 7: Brain Service (lazy, on first use)

| Step | What happens | File/Function |
|------|-------------|---------------|
| 25 | Brain service created | `createBrainService()` in Orchestrator constructor |
| 26 | Brain subscribes to events | `trackRunHealth()` called on each event |
| 27 | Brain analyzes post-run | `runBrainAnalysis()` in lifecycle runner |
| 28 | Brain provisions new runs | `getProvisioner().startRunForProposal()` |

---

## Critical Path

```
Module Load → Express Setup → Core Services → Proxy → Cleanup → Listen → Brain
     ↓              ↓              ↓            ↓        ↓         ↓        ↓
   config      middleware     AgentManager   proxy   orphan    HTTP    persistent
                              Orchestrator          reclaim   server   across runs
                              Broadcaster                     WS
```

---

## Key Invariants

1. **Proxy starts BEFORE listen** — `config.OLLAMA_BASE_URL` is rewritten in-memory before any agent spawns
2. **Orphan reclaim BEFORE listen** — prevents zombie processes from blocking ports
3. **Health check BEFORE listen** — warns about port/disk issues early
4. **Brain is lazy** — created on first use, persists across runs
5. **Graceful shutdown** — SIGINT/SIGTERM → stop orchestrator → close server → exit

---

## Startup Order Matters

| Must happen before | Why |
|-------------------|-----|
| Listen before agent spawn | Agents need HTTP server for WS events |
| Proxy before agent spawn | Agents need rewritten OLLAMA_BASE_URL |
| Orphan reclaim before agent spawn | Zombies could block ports |
| Brain after Orchestrator | Brain needs Orchestrator reference |

---

## Common Failure Modes

| Failure | Cause | Fix |
|---------|-------|-----|
| Port in use | Previous server still running | Kill process or change SERVER_PORT |
| Ollama unreachable | Proxy not started or Ollama down | Check proxy logs, verify Ollama |
| Orphan reclaim fails | Log file missing/corrupt | Non-fatal, logged and skipped |
| Brain not initialized | Orchestrator not created yet | Brain is lazy, created on first use |
| Auto-resume fails | Snapshot corrupted | Non-fatal, logged and skipped |
