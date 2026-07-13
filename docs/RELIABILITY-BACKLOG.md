# Reliability backlog (multi-day / multi-preset)

**Last updated:** 2026-07-13  
**Purpose:** Ranked failure points and mitigations. Code wins if this drifts.

### Operating assumption (operator feedback)

**AI provider / model reliability is not a first-class issue in this deployment.**
Cloud cold starts, quota storms, and “the model is dumb” are **out of scope** as
primary product risks. Focus reliability work on **our** control plane: lifecycle,
orchestration, UI truthfulness, composite presets, stop/drain, and autonomous end
conditions. Absolute prompt walls and caps remain as **local fail-closed safety nets**
(runaway stream / unbounded autonomous), not as a bet that the provider is flaky.

## P0 — user-visible wrongness or stuck runs (app-owned)

| Risk | Symptom | Mitigation status |
|------|---------|-------------------|
| Prompt without control plane | Dock live / sidebar ready | **Done:** `promptWithRetry` owns markStatus when not already busy; activity defaults |
| Stale sidebar busy | Thinking forever after done | **Done:** view demote + dock demote + activity done through suppress |
| Ghost agents after pipeline phase | Old agent-N cards after handoff | **Done:** `agents_roster` + phase handoff killAll |
| Dual event hubs / double broadcast | Missing or duplicate UI events | **Done:** single `createHub` + hub-only wrap emit |
| Hard stop does not settle | Stop returns late / workers linger in UI | **Done:** 45s worker + 10s loop race; timeout re-aborts + system line then killAll |
| Runaway continuous stream (no idle) | Idle wall never trips while still streaming | **Done:** absolute prompt wall-clock (local fail-closed) |
| Autonomous ignores resource caps | rounds=0 cycles without a stop signal | **Done:** cycle-boundary gates + default 8h wall if no cap on start |
| Blackboard caps silent to Brain/UI | Cap stop without RECONFIG / early-stop chip | **Done:** notifyGuardTrip + earlyStopDetail from terminationReason |
| chatOnce headless sidebar | Research/coach dock without status | **Done:** coach/stall/reflection/pre-pass/worker/outcome/ui-audit wired |

## P1 — degraded multi-day use

| Risk | Symptom | Mitigation status |
|------|---------|-------------------|
| Activity not on reconnect | Labels lost after refresh | **Done:** `/status` + WS on-connect activity |
| Pipeline phase invisible | User doesn’t know which sub-preset | **Done:** status `pipelinePhase` + RunHealthChip + status poll |
| Early-stop opaque | Run ended, reason buried | **Done:** RunHealthChip shows truncated detail + full tooltip |
| Headless activity labels | Sidebar only says "thinking" | **Done:** promptWithRetry default kind/label |
| Provider parallel overload | Quota storms, all agents retry | **Policy:** open fan-out; use failover / lower agentCount |
| Historical token totals wrong | 1d / all-time misleading | **Partial:** single `recordChatUsage`; old runs estimated |
| Soft-drain vs hard-stop confusion | Wrong button behavior | **Documented** in `run-stop-drain-lifecycle.md` |

## P2 — product / security / polish

| Risk | Mitigation |
|------|------------|
| Experimental presets feel “core” | Keep maturity badges; fail-closed where possible |
| Multi-writer conflicts | Prefer single-writer; CAS on blackboard |
| Unauthenticated LAN bind | Token required when host non-loopback (release plan) |
| Event log disk growth | Debug rotation exists; prune scripts for long fleets |
| Brain auto-provision | Off by default |

## Working principles

1. **One control plane per prompt** — manager + activity + status; no headless streams.
2. **Fail closed on composite** — pipeline phase failure stops pipeline.
3. **Primary stop gates** — empty/junk, plan-empty, caps, board stuck (not Jaccard).
4. **Reconnect honesty** — REST `/status` must carry agents + activity + streaming.
5. **Presets are products** — experimental paths get labels, not silent partial features.
