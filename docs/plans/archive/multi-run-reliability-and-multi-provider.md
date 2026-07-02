# Multi-Run Reliability + Multi-Provider Expansion

**Created:** 2026-07-02  
**Goal:** Make `SWARM_MAX_CONCURRENT_RUNS > 1` safe for overlapping execution, and evolve shared AI capacity from a single Ollama proxy into a fair, multi-provider routing layer.

**Current safe mode:** `SWARM_MAX_CONCURRENT_RUNS=1` (or cap>1 with only one run in `executing` at a time).

---

## Problem summary

| Layer | Status | Risk |
|-------|--------|------|
| Run registry + cap | ✅ Good | Low |
| Clone locks | ✅ Good | Low |
| Per-run REST / WS filter | ✅ Mostly | Medium (`agent_state` leaks) |
| Agent execution | ❌ Shared `AgentManager` | **Critical** |
| Event stamping / persistence | ❌ `activeRun` getters in `wrappedEmit` | **Critical** |
| Quota / rate limits | ⚠️ Global Ollama proxy only | Medium |
| UI multi-run | ✅ `/runs/:runId` | Medium on `/` route |

Provider routing (`pickProvider`, Anthropic/OpenAI/Ollama/OpenCode) already exists server-side. The gap is **per-run isolation** and **per-provider capacity management**, not basic provider support.

---

## PR DAG (dependency order)

**Status (2026-07-02):** PR-1 through PR-9 **landed**. Phase A (multi-run) + Phase B (provider gateway) complete behind `PROVIDER_GATEWAY=1` / `SWARM_FAIR_SCHEDULING=1`.

```
PR-1  Per-run AgentManager                    ✅ DONE
  └─► PR-2  Bind wrappedEmit to ActiveRun     ✅ DONE
        └─► PR-3  Stamp runId on all agent events  (partial — agent events done)
              └─► PR-4  Integration test: dual live runs
                    └─► PR-5  UI event guards + legacy route cleanup

PR-6  Per-run quota state (parallel with PR-2)
  └─► PR-7  ProviderGateway (multi-provider capacity)
        └─► PR-8  Per-run model routing + UI provider parity
              └─► PR-9  Fair scheduling + observability
```

PRs 1–5 unblock reliable multi-run. PRs 6–9 address shared AI capacity and your multi-provider goal.

---

## PR-1: Per-run `AgentManager`

**Why first:** Single global `AgentManager` is the hard blocker. All runs share `agent-1`, `agent-2`, streaming maps, and `killAll()`.

### Design

```typescript
// Orchestrator.ts — each ActiveRun owns its manager
interface ActiveRun {
  runId: string;
  manager: AgentManager;  // NEW — scoped to this run
  // ...existing fields
}
```

- Mint `new AgentManager(emit, broadcast, log, pidTracker)` inside `start()` per `ActiveRun`.
- Agent IDs stay `agent-{index}` **within a run**; WS events carry `runId` (PR-3) so cross-run collision is impossible on the wire.
- `Orchestrator.stopRun(runId)` calls `activeRun.manager.killAll()`, not the global manager.
- `index.ts` keeps a thin **factory** or **delegating shell** only if legacy code still imports a singleton — prefer removing the global manager entirely.

### Files

| File | Change |
|------|--------|
| `server/src/services/Orchestrator.ts` | `ActiveRun.manager`; pass per-run manager into `buildRunner` |
| `server/src/index.ts` | Replace singleton `manager` with factory `createAgentManager(runId, emit)` |
| `server/src/swarm/presetRouter.ts` | Thread `manager` through runner opts (already on `OrchestratorOpts`) |
| `server/src/services/AgentManager.ts` | Optional `runId` field for logging/PID tracker attribution |
| `server/src/services/agentPids.ts` | Tag PIDs with `runId` for orphan reclamation |

### Acceptance criteria

- [ ] Two runs with different `localPath` can both spawn agents without overwriting each other's `AgentState`
- [ ] `stopRun(A)` does not kill agents belonging to run B
- [ ] `killAll` on server shutdown still reclaims all runs' agents
- [ ] Unit test: two managers, concurrent `spawnAgentNoOpencode`, independent state maps

### Estimated scope: ~400 LOC, 1–2 days

---

## PR-2: Bind `wrappedEmit` to `ActiveRun`

**Why:** `wrappedEmit` reads `this.runId`, `this.runStatePersister`, `this.runner` via getters that resolve to the **most recently inserted** run. Under overlap, events and snapshots attach to the wrong run.

### Design

Capture run context at construction time:

```typescript
// Inside start(), after activeRun is created:
const runId = activeRun.runId;
const persister = activeRun.persister;
const getRunner = () => activeRun.runner;

const wrappedEmit = (e: SwarmEvent) => {
  const stamped = e.runId === undefined ? { ...e, runId } : e;
  baseEmit(stamped);
  brainService?.trackRunHealth(stamped);
  const status = getRunner().status();
  persister.schedule({ runId, ... });
};
```

Remove lazy `this.runId` / `this.runStatePersister` from the hot path. Keep `activeRun` getters **only** for legacy single-arg APIs (`status()`, `stop()` without id).

### Also fix in this PR

| Issue | Fix |
|-------|-----|
| `addAmendment(runId)` checks `this.runId` | Compare against `runs.get(runId)` |
| `amendments.close(runId)` in `start()` `finally` | Move to `stopRun()` / terminal phase only |
| `scheduleForwardChain` uses `this.runner` | Close over `activeRun` |
| `recoverRun` assumes latest run | Return + use explicit `newRunId` throughout |

### Files

- `server/src/services/Orchestrator.ts` (primary)
- `server/src/services/Orchestrator.multiTenant.test.ts` → add **runtime** dual-run test (not regex-only)

### Acceptance criteria

- [ ] Run A's `transcript_append` events always carry A's `runId` even while B is starting
- [ ] `.run-state.json` for clone A never receives B's transcript
- [ ] `/amend` works mid-run (buffer not closed at boot)

### Estimated scope: ~250 LOC, 1 day

---

## PR-3: Stamp `runId` on all agent events

**Why:** `agent_state` and streaming events bypass `wrappedEmit`. WS filter drops events without matching `runId`, but **passes through** events with **no** `runId` — causing cross-run UI bleed.

### Design

```typescript
// Per-run AgentManager emit wrapper (from PR-1):
const emitAgentState = (s: AgentState) =>
  broadcast({ type: "agent_state", agent: s, runId });

const emitStreaming = (e: SwarmEvent) =>
  broadcast(e.runId ? e : { ...e, runId });
```

### Schema / types

| File | Change |
|------|--------|
| `shared/src/wsProtocol.ts` | `agent_state` + `agent_streaming*` variants: optional `runId` → **required** when emitted from server |
| `server/src/types/events.ts` | Mirror schema |
| `web/src/state/applyEvent.ts` | Defensive: drop events where `ev.runId !== store.runId` when store has `runId` |

### Acceptance criteria

- [ ] `/runs/:runId` tab shows only that run's agents
- [ ] `broadcast.test.ts`: filtered client does not receive other run's `agent_state`
- [ ] SwarmView agent panels correct with 2 concurrent runs

### Estimated scope: ~200 LOC, 0.5–1 day

---

## PR-4: Integration test — dual live blackboard runs

**Why:** Existing `Orchestrator.multiTenant.test.ts` checks source patterns, not behavior.

### Test scenario

1. Start run A (blackboard, clone path `/tmp/swarm-test-a`, `agentCount=2`, mock provider)
2. Start run B (different clone `/tmp/swarm-test-b`) while A is in `executing`
3. Assert:
   - Both in `orchestrator.listActiveRuns()`
   - WS client `?runId=A` receives zero events with `runId=B`
   - Agent states for A and B are disjoint
   - Stop A → B continues
   - Snapshots written to correct sibling `.run-state.json`

### Files

- `server/src/services/Orchestrator.concurrent.integration.test.ts` (new)
- `server/scripts/run-tests.mjs` — register file

### Acceptance criteria

- [ ] Test fails on `main` before PR-1/2/3, passes after
- [ ] CI runs in <30s (mock `SessionProvider`)

### Estimated scope: ~300 LOC, 1 day

---

## PR-5: UI hardening + legacy route cleanup

### Changes

| Item | Action |
|------|--------|
| `/` route | Redirect to `/runs/:activeRunId` when a run is active; or show `ActiveRunsPanel` prominently |
| `useSwarmSocket` on `/` | Always pass `?runId=` once known (from status hydrate) |
| `applyEvent.ts` | Client-side `runId` guard (belt + suspenders) |
| `POST /api/swarm/start` | Response includes `runId` + `navigateTo: /runs/:id` hint |
| Setup form | "Start another run" opens new tab at `/runs/new` without clobbering active store |
| `ActiveRunsPanel` | Show when ≥1 run (not only ≥2) |

### Acceptance criteria

- [ ] User can run A, open B in second tab, both UIs stay isolated
- [ ] No `agent_state` bleed in either tab
- [ ] Stopping from either tab hits correct per-run REST endpoint

### Estimated scope: ~350 LOC, 1–2 days

---

## PR-6: Per-run quota state

**Why:** `tokenTracker.clearQuotaState()` on any `start()` clears quota for all runs. `quota` is a single global flag. One run hitting a wall affects others.

### Design

```typescript
// ollamaProxy.ts
class TokenTracker {
  private quotaByRun = new Map<string, QuotaState>();
  private globalOllamaQuota: QuotaState | null = null; // upstream-wide

  setQuotaState(runId: string | undefined, state: QuotaState): void;
  getQuotaState(runId?: string): QuotaState | null;
  clearQuotaState(runId?: string): void; // undefined = clear all (shutdown only)
}
```

- Orchestrator `start()` → `clearQuotaState(runId)` not global clear
- Runners check `getQuotaState(this.runId)` for pause/stop
- `/api/usage?runId=X` already exists — wire to per-run map
- Global upstream 429 still visible as `globalOllamaQuota` (informational)

### Acceptance criteria

- [ ] Run A quota wall pauses A only; B continues if upstream allows
- [ ] Starting run C does not clear A's quota history mid-flight
- [ ] `stopReason: cap:quota` attributed to correct run

### Estimated scope: ~300 LOC, 1 day

---

## PR-7: `ProviderGateway` — multi-provider capacity layer

**Why:** Today all Ollama traffic goes through one proxy (`11533`). Anthropic/OpenAI calls bypass it entirely with no shared rate-limit / quota / attribution fabric. You want all providers usable with fair concurrent access.

### Architecture

```
Runner prompt
    │
    ▼
ProviderGateway.chat({ runId, model, ... })
    │
    ├─► pickProvider(model)        // existing
    ├─► RateLimiter[provider]      // token bucket per provider
    ├─► QuotaTracker[runId][provider]
    └─► UsageRecorder[runId][provider]
```

### New module: `server/src/providers/ProviderGateway.ts`

Responsibilities:
1. **Single entry** for all `AgentManager.streamPrompt` / `promptDirect` calls
2. **Per-provider rate limits** (configurable defaults):
   - `ollama`: ~10 req/s (from `perf-analysis.ts`)
   - `anthropic` / `openai`: respect 429 + Retry-After
   - `opencode`: conservative default
3. **Per-run attribution** on every usage record
4. **Failover chain** (`cfg.providerFailover`) evaluated inside gateway, not scattered per runner
5. **Circuit breaker** per provider: N failures → open for M seconds → half-open probe

### Config (env)

```bash
PROVIDER_RATE_LIMIT_OLLAMA=10      # req/s
PROVIDER_RATE_LIMIT_ANTHROPIC=5
PROVIDER_RATE_LIMIT_OPENAI=5
PROVIDER_CIRCUIT_BREAKER_THRESHOLD=3
PROVIDER_CIRCUIT_BREAKER_COOLDOWN_MS=60000
```

### Migrate

| From | To |
|------|-----|
| `ollamaProxy.ts` token capture | `ProviderGateway` Ollama adapter (keep proxy for local token sniffing OR move capture into gateway) |
| `pickProvider()` direct in AgentManager | `gateway.chat()` wraps pick |
| `promptWithFailoverAuto` | Delegate failover to gateway |

### Acceptance criteria

- [ ] Blackboard run on `anthropic/claude-sonnet-4-6` works concurrently with Ollama run
- [ ] 429 on provider A triggers failover within run, not global pause
- [ ] `/api/usage?runId=X` breaks down by provider

### Estimated scope: ~600 LOC, 2–3 days

---

## PR-8: Per-run model routing + UI provider parity

**Why:** Infrastructure supports 5 providers; defaults and UX still center Ollama Cloud + deepseek-v4-flash. You want every provider/model available per role.

### Server

| Item | Action |
|------|--------|
| `RunConfig` | Already has per-role models (planner/worker/auditor) — validate all accept prefixed models |
| `RepoService` | Ensure `writeOpencodeConfig` groups all providers (already does) |
| Topology grid | Per-agent model override → `detectProvider` on each |
| Preflight | Check API keys per provider used in config, not just Ollama |
| Default model | Keep `deepseek-v4-flash:cloud` as default but don't hardcode in runners |

### Web

| Item | Action |
|------|--------|
| `ProviderTabs` | Already splits ollama / ollama-cloud / anthropic / openai / opencode |
| `ModelSelect` | Per-role picker respects provider tab |
| `TopologyGrid` | `ModelInput` → consider `ModelSelect` per cell (optional) |
| Preflight banner | "Missing ANTHROPIC_API_KEY for planner model" per provider |
| Cost breakdown | Extend `costBreakdown.ts` beyond Ollama pricing |

### Per-run provider mix example

```json
{
  "model": "deepseek-v4-flash:cloud",
  "plannerModel": "anthropic/claude-sonnet-4-6",
  "workerModel": "openai/gpt-5-mini",
  "auditorModel": "deepseek-v4-flash:cloud",
  "providerFailover": ["deepseek-v4-flash:cloud", "anthropic/claude-haiku-4-5-20251001"]
}
```

### Acceptance criteria

- [ ] Start run with 3 different providers across roles — all prompts route correctly
- [ ] Missing key for one provider fails preflight with actionable message
- [ ] Discovery lists populate for all providers with keys set

### Estimated scope: ~400 LOC, 1–2 days

---

## PR-9: Fair scheduling + observability

**Why:** With N concurrent runs and M providers, naive FIFO causes one run to starve others.

### Design

**Prompt scheduler** (inside `ProviderGateway` or Orchestrator):

```typescript
interface PromptJob {
  runId: string;
  priority: number;       // user-steered run > background brain run
  provider: Provider;
  submittedAt: number;
}
```

- Per-provider queue with weighted fair queuing across `runId`
- Config: `SWARM_FAIR_SCHEDULING=1` (default on when `SWARM_MAX_CONCURRENT_RUNS > 1`)
- Surface in UI: per-run "waiting for provider capacity" indicator

### Observability

| Endpoint / UI | Shows |
|---------------|-------|
| `GET /api/swarm/active-runs` | phase, provider mix, queue depth |
| `GET /api/providers/health` | circuit state, rate-limit headroom per provider |
| `SystemStatusPanel` | Provider health chips (not just Ollama) |
| `RunHeaderWidgets` | Per-run token usage by provider |

### Acceptance criteria

- [ ] 4 concurrent runs share Ollama 10 req/s without one run monopolizing
- [ ] Dashboard shows which provider is the bottleneck
- [ ] Brain-provisioned runs get lower priority than user-started runs

### Estimated scope: ~500 LOC, 2 days

---

## Rollout strategy

### Phase A — Safe multi-run (PR-1 → PR-5)

1. Land PR-1 + PR-2 together (tightly coupled)
2. PR-3 + PR-4
3. PR-5 (UI)
4. Change default: document `SWARM_MAX_CONCURRENT_RUNS=4` as safe
5. Add startup warning if cap>1 before PR-1 ships (guard rail)

### Phase B — Multi-provider capacity (PR-6 → PR-9)

1. PR-6 (per-run quota) can ship independently
2. PR-7 is the largest — feature-flag `PROVIDER_GATEWAY=1`
3. PR-8 + PR-9 once gateway is stable

### Feature flags

```bash
SWARM_MAX_CONCURRENT_RUNS=4        # safe after Phase A
PROVIDER_GATEWAY=1                 # Phase B
SWARM_FAIR_SCHEDULING=1            # Phase B, requires gateway
```

---

## Testing matrix (final state)

| Scenario | Expected |
|----------|----------|
| 2 blackboard runs, different clones, overlapping execute | Both progress, isolated agents + events |
| 2 tabs, same runId | Identical state |
| 2 tabs, different runIds | No cross-talk |
| Same clone path, 2 starts | Second rejected (lock) |
| Run A: anthropic planner, Run B: ollama workers | Both work, separate quota |
| Ollama 429 on run A | A fails over or pauses; B unaffected |
| 4 runs at cap | 5th start returns 409 / clear error |
| Server SIGTERM mid-run | All runs stop, clones unlocked, PIDs reclaimed |

---

## Out of scope (future)

- Separate OS processes per run (true sandboxing)
- Per-run Ollama proxy ports (unnecessary once `ProviderGateway` handles rate limits)
- Kubernetes / horizontal scale-out
- Billing / cost caps per user (multi-tenant SaaS)

---

## Quick reference: files touched

```
server/src/services/Orchestrator.ts      # PR-1, PR-2
server/src/services/AgentManager.ts      # PR-1, PR-3
server/src/index.ts                      # PR-1
server/src/ws/broadcast.ts               # PR-3
server/src/services/ollamaProxy.ts       # PR-6, PR-7
server/src/providers/ProviderGateway.ts  # PR-7 (new)
server/src/providers/pickProvider.ts     # PR-7 (wrapped)
shared/src/wsProtocol.ts                 # PR-3
web/src/state/applyEvent.ts              # PR-3, PR-5
web/src/hooks/useSwarmSocket.ts          # PR-5
web/src/App.tsx                          # PR-5
docs/known-limitations.md                # Update after Phase A
```