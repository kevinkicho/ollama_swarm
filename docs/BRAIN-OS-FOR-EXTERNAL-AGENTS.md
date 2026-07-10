# Brain-OS for External Agents

This guide helps external LLM agents, scripts, or tools use **Brain-as-OS** to configure, start, steer, and analyze swarm runs end-to-end.

Brain acts as a librarian / master-admin: use-case tables in [`docs/swarm-patterns.md`](swarm-patterns.md) and [`docs/STATUS.md`](STATUS.md), historical outcomes, and mid-run control APIs.

> **Machine-readable map:** `GET /api/swarm/brain/control-surface`  
> **CLI mirror:** `ollama-swarm control-surface --json`

---

## Lifecycle control (start → during → after)

### Start (before run)

| Action | API | CLI |
|--------|-----|-----|
| Recommend preset | `GET /api/swarm/outcome/recommend?directive=` | `ollama-swarm recommend --directive "..."` |
| Conversational config | `POST /api/swarm/brain/chat` (`structured: true`) | — |
| Preflight disk/clone | `GET /api/swarm/preflight?parentPath=&repoUrl=` | — |
| Start run | `POST /api/swarm/start` | `ollama-swarm start --directive ... --preset ...` |
| Approve follow-up run | `POST /api/swarm/brain/provision` (`approved: true`) | — |

**Start body (high-signal fields):** `parentPath`, `repoUrl`, `userDirective`, `preset`, `agentCount`, `rounds` / `continuous`, `model` / `plannerModel` / `workerModel`, `webTools`, `plannerTools`, `topology`, `wallClockCapMs`, `tokenBudget`, `writeMode`, `ambitionTiers`, `verifyCommand`.

Returns `{ runId, navigateTo: "/runs/<runId>" }` — always use the runId for subsequent calls.

### During (live run)

| Action | API | CLI |
|--------|-----|-----|
| Status / phase / board | `GET /api/swarm/runs/:runId/status` | `ollama-swarm status --run-id` |
| List active runs | `GET /api/swarm/active-runs` | `ollama-swarm list` |
| Directive addendum | `POST /api/swarm/amend` | `ollama-swarm amend --run-id --text` |
| Extend limits | `POST /api/swarm/reconfig` | `ollama-swarm reconfig --run-id --extend-wall-clock-min 15` |
| Inject message | `POST /api/swarm/say` | `ollama-swarm say --run-id --text --intent steer` |
| Brain suggestion bubble | `POST /api/swarm/brain/suggest` | — |
| Soft stop | `POST /api/swarm/drain` | `ollama-swarm drain --run-id` |
| Hard stop | `POST /api/swarm/stop` or `.../runs/:id/stop` | `ollama-swarm stop --run-id` |
| Tokens / quota | `GET /api/usage?runId=` | — |
| Live Brain chat | `POST /api/swarm/brain/chat` + `runContext` | — |

**Reconfig (extend-only):** `extendRounds`, `extendWallClockCapMin`, `extendTokenBudget`, absolute `rounds` / `wallClockCapMin` / `tokenBudget` (must not shrink), think-guard referee knobs.

### After (close-out / analysis)

| Action | API | CLI |
|--------|-----|-----|
| Run summary | `GET /api/swarm/run-summary?runId=&clonePath=` | `ollama-swarm summary --run-id --clone-path` |
| Event log | `GET /api/v2/event-log/runs/:runId` | — |
| Brain proposals | `GET /api/swarm/brain/proposals` | — |
| Brain activity | `GET /api/swarm/brain/activity` | — |
| Memory / project graph | `/api/swarm/memory`, `/api/swarm/project-graph` | — |
| Dismiss proposal | `POST /api/swarm/brain/reject` | — |

UI: **Brain follow-ups** sidebar → **Approve & start** (same as provision API).

---

## Recommended agent loop

```text
1. control-surface → discover endpoints
2. recommend | brain/chat structured → pick preset + models
3. start → capture runId
4. loop: status every N s
   - if quota / no-progress detail contains provider-quota → reconfig extend wall-clock or stop
   - if stuck on wrong files → amend text
   - if need focus → say intent=steer
5. drain or stop
6. summary + event-log → learn; optional provision next follow-up
```

Example script: `examples/brain-agent-loop.mjs`.

---

## Use-case tables

See README (“Using for Scientific Research & Internet Work”) and the preset matrix in `STATUS.md`. Prefer **Simple** presets (core + supported) unless Advanced is required.

---

## How to talk to Brain effectively

1. Explicit goal + constraints (time, write vs read-only, agentCount).
2. Prefer `structured: true` for machine-readable `config`.
3. Pass `runContext` (phase, board, recent transcript) for mid-run advice.
4. Use amend/reconfig/say rather than restarting when possible.

See also `docs/STATUS.md` and `docs/RELEASE-1.0-PLAN.md`.
