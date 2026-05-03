# Multi-tenant runs — design draft (DEFERRED)

**Status**: PROPOSAL · 2026-05-02 · awaiting Kevin's nod before code.

The current architecture pins one swarm runner to the orchestrator
singleton. This doc describes what concurrent runs would need.

## What's blocking concurrency today

Every load-bearing piece assumes one run at a time:

1. **`Orchestrator.runner: SwarmRunner | null`** — single slot. The
   `start()` method explicitly throws if `isRunning()`.
2. **`Orchestrator.runId | runConfig | runStartedAt`** — singleton fields
   per orchestrator instance. There's no way to ask "what's the status
   of run X?"
3. **`AmendmentsBuffer.open(runId)` / `close(runId)`** — keyed by runId
   but only one is open at a time in practice (orchestrator only
   `open`s one).
4. **WebSocket broadcast** — every subscriber gets every event. No
   per-run channel.
5. **`RunStatePersister`** — one per active run, but the orchestrator
   only constructs one (recently shipped 2026-05-02 first-cut).
6. **REST routes** — `/api/swarm/status`, `/api/swarm/say`,
   `/api/swarm/stop` all target "the active run" — no `:runId` segment.
7. **UI** — `useSwarm` zustand store has one slice for "the run". One
   tab assumes one run.
8. **Clone path collision** — two runs against the same repo would
   both clone into the same `<parent>/<repoName>` dir.

## Target architecture

### Server side

**Multi-runner orchestrator.** Replace `runner: SwarmRunner | null` with
`runners: Map<string, ActiveRun>` where each `ActiveRun` carries:
```ts
{
  runner: SwarmRunner;
  runId: string;
  runConfig: SwarmStatusRunConfig;
  startedAt: number;
  amendmentsKey: string;       // already runId-keyed
  persister: RunStatePersister;
  conformanceMonitor?: ConformanceMonitor;
  embeddingDriftMonitor?: EmbeddingDriftMonitor;
}
```

Concurrency cap (env-tunable, default 4) so a runaway client can't
spawn unlimited runs.

**Per-run REST routes.** Add `/api/runs/<runId>/...` parallel to the
existing `/api/swarm/...` (which becomes a back-compat alias for
"the most recently started run"). New routes:
```
GET  /api/runs                    — list all active + recent runs (same shape as /api/swarm/runs but server-wide)
GET  /api/runs/<id>/status        — per-run status snapshot
POST /api/runs/<id>/say           — per-run user inject
POST /api/runs/<id>/stop          — per-run stop
WS   /ws?runId=<id>               — subscribe to one run's events
```

**WS broadcast scoping.** Every `SwarmEvent` gets a `runId` field
stamped at emit time. The broadcaster filters per-subscriber.

**Clone-path uniqueness.** Postfix with the runId tail when the user's
chosen `<parent>/<repoName>` is already in use by a live run:
```
parent/got/         (run A)
parent/got_a3f2/    (run B — collision-avoided)
```

### Client side

**Routing.** Add `react-router` with two routes:
- `/` — landing + recent-runs list + new-run form
- `/runs/<id>` — per-run page (current SwarmView's content, scoped
  to that runId)

**Per-run zustand store.** Either (a) one store per route via
`createStore` factory + React context, or (b) one store with
`Map<runId, RunSlice>` and components read by runId.

**WS connection per run.** `useSwarmSocket` takes a runId param +
opens `/ws?runId=<id>` so the client only receives events for the
run it's watching.

## Migration plan

This is the safe-staged version — no big-bang cutover, every step
keeps existing single-run paths working.

1. **Server: stamp runId on every SwarmEvent.** No behavior change;
   events just carry the field. Existing emit code mostly already has
   it. ~20 LOC + tests.
2. **Server: per-runId broadcast filter.** WS subscribers can ask
   "events for runId X only". Bare `/ws` (no query) keeps the legacy
   "all events" behavior. ~30 LOC + tests.
3. **Server: `Map<runId, ActiveRun>` introduced INTERNALLY**, but
   `start()` still rejects when the map is non-empty. Just refactors
   the field shape; semantics unchanged. ~150 LOC + tests.
4. **Server: relax the cap** — start() accepts new runs up to N
   (env-default 4). Add `/api/runs` listing endpoint. Existing
   `/api/swarm/*` routes target the most-recent-started run for
   back-compat. ~80 LOC + tests.
5. **Client: react-router scaffold** — wraps existing SwarmView in
   a route. `/` shows the new-run form + recent-runs. ~100 LOC.
6. **Client: per-run zustand factory** — useSwarmSocket(runId)
   takes the route param. ~80 LOC.
7. **Server: per-run REST routes** with the `/api/runs/<id>/...`
   shape. The legacy routes stay as aliases. ~60 LOC + tests.
8. **Client: navigate to `/runs/<id>` on start** — existing setup
   form gets push to the new route on submit. ~20 LOC.

Total estimate: **~540 LOC server + ~200 LOC client + ~120 LOC tests
≈ 860 LOC + ~3-4 days focused work.** Higher than my mental model
because (a) routing introduction is invasive, (b) every existing route
needs a back-compat alias path, (c) WS subscriber filter needs careful
testing to avoid event leaks across runs.

## Open questions

1. **Auth.** Multi-tenant means multiple users want to NOT see each
   other's runs. Today there's zero auth. Do we add a session token
   and namespace runs by token, or stay LAN-trusted-network?
2. **Resource caps per concurrent run.** Each blackboard run can pin
   4-5 Ollama agents + 1 dev-server vite + N MCP tool calls. 4
   concurrent runs ≈ 20 agents × 4-5 GB GPU each. Need per-user (or
   per-host) limits.
3. **Recovery integration.** The persister's recovery flow (deferred)
   needs to coexist with multi-tenancy — on restart, scan for
   orphaned `run-state.json` files and present "resume?" UI per-run.
4. **`/api/swarm/runs` semantics.** Today it's "all historical runs in
   this parent dir". With multi-tenant, does it become "active runs
   only" or stay "historical + active"? Pick before touching it.

## Recommendation

**Don't ship this without first deciding (1) auth model and (3)
recovery integration.** Both shape the data model. Building the
runner-Map first then bolting auth on later is the kind of refactor
that costs more than building it right.

Concrete next step: Kevin picks auth posture (LAN-trusted vs token-based)
and recovery posture (auto-resume vs prompt). Then a design pass through
this doc, then phase 1 starts.
