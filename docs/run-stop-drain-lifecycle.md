# Run Stop, Drain, and Close-Out Lifecycle

Canonical description of **ideal** stop/drain behavior. Use this when debugging
transcript lines that appear after “Run stopped”, “ports released”, or when close-out
feels out of order. If implementation diverges, treat this doc as the contract to
restore — not the other way around.

**Primary code:** `CouncilRunner.ts`, `councilWorkerRunner.ts`, `AgentManager.ts`,
`ActiveRun.ts`, `Orchestrator.stopRun()`, blackboard `lifecycleRunner.ts` / `drain.ts`.

**Related:** `docs/decisions.md` (2026-07-08 close-out decision), `docs/AGENT-GUIDE.md`
(council architecture), `server/src/swarm/blackboard/ARCHITECTURE.md` (terminal phases).

---

## Two stop modes

| Mode | API | User intent | Runner method |
|------|-----|-------------|---------------|
| **Hard stop** | `POST /api/swarm/stop` | Stop now; abandon in-flight work after abort grace | `CouncilRunner.stop()` |
| **Soft drain** | `POST /api/swarm/drain` | Finish the **current** in-flight todo per worker, then hard stop (3 min backstop) | `CouncilRunner.drain()` |

**API honesty:** `POST /drain` and `POST /runs/:runId/drain` return
`{ ok, mode, message }` where `mode` is `soft` | `hard-fallback` | `already-stopped`.
Runners without `drain()` (e.g. baseline) report `hard-fallback` and the UI must
not pretend soft-drain started. Failed drain must not force phase=`stopped`.

**Multi-tenant parity:** `POST /runs/:runId/stop` shares `SWARM_DRAIN_ON_STOP`
with legacy `POST /stop` (first click drain, second within 5s kill). Prefer
per-run paths when more than one run is active.

**Do not conflate them:**

- Hard `stop()` sets `stopping = true` and aborts `stopAbortController`. It must **not**
  set `drainRequested` (that flag is for soft drain only).
- Soft `drain()` sets `drainRequested = true`, enters `draining` phase, waits for workers
  to finish their **current** todo, then escalates to the same close-out path as hard stop.

Blackboard uses the same conceptual split via `lifecycleState`: `running` → `draining` →
`stopping` → `stopped`. Council mirrors it with `stopping`, `drainRequested`, and
`closingRequested()`.

---

## Ideal hard-stop sequence (council)

When the user presses **Stop** during any phase (including execution):

```
1. stop() called
   ├─ stopping = true
   ├─ state.stopping = true
   └─ stopAbortController.abort("user stop")

2. awaitLoopThenCloseOut({ immediate: true })
   ├─ IF workerDrainPromise is set (execution in flight):
   │     wait up to HARD_STOP_WORKER_WAIT_MS (45s) for workers after abort
   │     on timeout: system line + beginRunShutdown() again (force abort)
   └─ wait up to HARD_STOP_LOOP_WAIT_MS (10s) for main loop; timeout re-aborts

3. closeOutStopped()
   ├─ phase → "stopping"
   ├─ [optional] persist pending-execution-todos.json + "[resume] Saved N …"
   ├─ writeSummary() → run-finished banner + "Wrote run summary …"
   ├─ transcriptFrozen = true          ← no more worker/system lines after this
   ├─ killAll()
   │     ├─ abort every Session.abortController (cancel in-flight provider HTTP)
   │     ├─ reject in-flight streamPrompt awaiters
   │     └─ clear agent roster
   ├─ "✓ All N agent ports released cleanly."  (via super.appendSystem, bypasses freeze)
   └─ phase → "stopped"
```

**Invariant:** After step 3’s `transcriptFrozen = true`, **no** execution lines, literature
research notes, worker hunks, or `[execution] Complete:` summaries should appear. If they
do, close-out ran too early or stragglers were not aborted.

---

## Ideal soft-drain sequence (council)

```
1. drain() called → drainRequested = true, phase = "draining"
2. Workers finish the todo they already claimed (no new dequeues after drain break)
3. After 3 min backstop OR all workers idle → same closeOutStopped() as hard stop
```

Worker loop contract (`councilWorkerRunner.ts`):

```ts
while (!ctx.stopping()) {
  if (ctx.draining?.()) break;   // soft drain: exit after current todo
  // dequeue + execute …
}
```

During **hard** stop, `stopping === true` ends the loop on the next iteration; the
**current** `executeTodoWithRetryChain` may still run until abort completes or the
provider returns.

---

## Execution worker obligations

These rules apply to council execution (`runCouncilWorkers`) and should be preserved
if worker code is refactored:

| Rule | Why |
|------|-----|
| `drainTodos` tracks `workerDrainPromise`; close-out **waits** for it on hard stop | Prevents summary/killAll while workers are still in flight |
| Every provider call in the worker path passes an **abort signal** wired to `stopAbortController` | Cloud HTTP is not tied to “ports”; abort must cancel fetch |
| Literature pre-pass (`runCouncilLiteratureResearch`) uses the same `promptSignal` | Was a common straggler after stop |
| Hunk-repair retries reuse the same `AbortController`, not a fresh one | Repair prompts must not outlive stop |
| `tryWorkerPrompt` checks `ctx.stopping()` before starting a todo | Skip new work once stop is requested |
| `appendSystem` / `appendCouncilAgent` respect `transcriptFrozen` after summary write | Blocks post-close-out transcript pollution |

---

## AgentManager `killAll()` contract (E3 / no-opencode path)

Agents no longer run local `opencode serve` subprocesses. “Ports released cleanly” is
mostly bookkeeping; **real** cancellation is:

1. `Session.abortController.abort()` for each spawned session (stored in `AgentManager.sessions`)
2. `streamingByAgent` reject with `"agent killed"`
3. `killed = true` so late `setAgentState` calls are dropped

**Regression signal:** “ports released” followed by new `agent_N` transcript entries or
token usage on a stopped run → in-flight HTTP was not aborted or close-out did not wait
for workers.

---

## Transcript ordering (what users and agents should expect)

### Live UI (WebSocket `transcript_append`)

1. Last **worker** lines (if stop caught mid-execution) may appear **before** terminal lines.
2. Terminal block (in order):
   - `═ Run stopped — user … ═` (run-finished banner)
   - `Wrote run summary (stopReason=user, …)`
   - `✓ All N agent ports released cleanly.`
3. **Nothing** after “ports released” except UI hydration from history.

### `summary.json` on disk

`writeRunSummary` builds the transcript snapshot **before** appending the run-finished
banner to the live transcript. So `summary.json` may end at `[resume] Saved N pending …`
or the last worker line, **without** the banner or ports line. That is expected; live UI
and `.run-state.json` persister carry the full terminal tail.

---

## Debugging checklist

| Symptom | Likely cause | Where to look |
|---------|--------------|---------------|
| Literature / hunks / `[execution] Complete` **after** “ports released” | Close-out raced ahead of `workerDrainPromise`; or prompt not aborted | `CouncilRunner.awaitLoopThenCloseOut`, `workerDrainPromise`, `councilWorkerRunner` signals |
| Stop returns quickly but work continues 10–30s | Old 15s loop race (fixed 2026-07-08) or missing `workerDrainPromise` wait | `awaitLoopThenCloseOut` |
| `drainRequested` set on hard stop | Soft-drain semantics leaked into `stop()` | `CouncilRunner.stop()` body |
| Agents show “thinking” after stop in sidebar | `setAgentState` after `killed=true` or WS replay | `AgentManager.killAll`, web `applyEvent` |
| Summary says `filesChanged: 0` but commits exist | Snapshot timing at user-stop (see postmortems) | `discussionWriteSummary`, git status at close-out |
| Run stuck in `stopping` 15+ min | Awaiter never settled (historical opencode abort hang) | `AgentManager.killAll` timeout chain |

---

## Regression tests to keep green

- `CouncilRunner.test.ts` — `workerDrainPromise`, hard stop must not set `drainRequested`
- `AgentManager.killAgent.test.ts` — `killAll` aborts session controllers
- `CouncilRunner.test.ts` — close-out writes summary before `formatPortReleaseLine`

When changing stop/drain code, add or extend tests if you touch:

- `awaitLoopThenCloseOut`
- `drainTodos` / `runCouncilWorkers`
- `killAll` / session lifecycle
- `appendSystem` guards on runners

---

## Blackboard parity (brief)

Blackboard’s `lifecycleRunner` uses `ctx.killAll()` in `drain.ts` after setting
`lifecycleState = "stopping"`. Same principles apply: do not write summary or kill agents
while workers still hold in-flight provider calls unless those calls are aborted. See
`server/src/swarm/blackboard/ARCHITECTURE.md` for terminal `stopReason` / phase mapping.

---

## History

- **2026-07-07** — Council close-out rework: `stopping` → summary → `killAll` (changelog).
- **2026-07-08** — Run `43e79fa7` postmortem driver: execution stragglers after “ports
  released” due to loop 15s race + literature research without abort + no transcript
  freeze. Fixed in code; this doc captures the intended contract.