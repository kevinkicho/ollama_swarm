# Deep reliability sweep — 2026-07-17

Full-codebase audit after residual RR landings. Focus: dead loops, leaks, apply partials, stop races.

## Shipped in this pass (`main`)

| Fix | Severity | Notes |
|-----|----------|-------|
| Council build todo `signal` + reaper register | CRITICAL | Stop no longer leaves build chatOnce orphaned |
| `clearRunTelemetry` after summary | HIGH | apply/cycle/research/heartbeat maps no longer grow forever |
| Bash backoff reset on run start | HIGH | `agent-N` ids no longer inherit prior-run lockouts |
| `summaryWritten` only after successful write | HIGH | Failed I/O can retry on next close-out |
| Baseline multi-file fail-closed | HIGH | No silent partial land; opt-in `SWARM_BASELINE_PARTIAL_APPLY=1` |
| Wrap-up mixed dry-run → full fallthrough | HIGH | No subset apply of incomplete synthesizer sets |
| `propose_hunks` apply all-or-nothing + revert | HIGH | Mid-write failure restores prior contents |
| `lastApplyMiss` clear on replan + TTL / expectedFiles filter | HIGH | Stale anchors don’t poison next seed |
| Research blackout prefer budget as source of truth | MED | Dual-state mirror reduced |

## Still open (follow-up, not blocking live)

1. **Debug WriteStream close** on `ActiveRun.releaseResources` (FD growth multi-run server).
2. **Empty-execution `void this.stop()`** mid-cycle race — prefer return `stop` from cycle.
3. **WorkerPipeline write-loop** same all-or-nothing snapshot as propose_hunks.
4. **Wrap-up JSON force** (`formatExpect` / `ollamaFormat`) on provider.chat path.
5. **expectedFiles path normalize** (`./a` vs `a`) to cut false thrash.
6. **isLiteratureTodo** phrase table (find papers / look up sources).
7. **Close-out mutex** for concurrent drain/stop.
8. **Stop debounce map prune** after terminal.

## Operator env flags

| Flag | Default | Effect |
|------|---------|--------|
| `SWARM_APPLY_DETERMINISTIC_CANDIDATE` | off | Try `uniqueCandidates[0]` before LLM repair |
| `SWARM_BASELINE_PARTIAL_APPLY` | off | Legacy baseline per-file partial apply |

## Live-run watch list

- Build todos abort promptly on Stop.
- Long multi-run server: no growing memory from integrity maps.
- Wrap-up: partial synthesizer → re-prompt, not silent subset commit.
- `propose_hunks apply:true` failure message mentions `reverted N file(s)`.
