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

## Wave-2 shipped (same program)

| Item | Status |
|------|--------|
| Debug WriteStream close on `ActiveRun.releaseResources` | **Done** — `EventSink.close` + `hub.close()` |
| Empty-execution no `void this.stop()` | **Done** — set `stopping` + cycle returns via `closingRequested` |
| WorkerPipeline write-loop snapshot revert | **Done** |
| Wrap-up JSON force (`format: "json"`) | **Done** |
| expectedFiles path normalize | **Done** — `normalizeRepoPath` |
| isLiteratureTodo phrase table | **Done** — find/look up/gather papers |
| Close-out single-flight stop/drain | **Done** — join `stopInFlight` |
| Stop debounce map prune | **Done** — `clear` + `retain(activeRunIds)` |

## Optional further hardening (low priority)

1. Path-normalize at apply time for Windows drive letters edge cases.
2. Wrap-up use full `promptWithRetry` stack (stream sniff) not only `format: json`.
3. Debug meta sidecar after `hub.close` if list UI needs final flush.
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
