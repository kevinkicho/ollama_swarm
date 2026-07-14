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
| Historical token totals wrong | 1d / all-time misleading | **Done:** live + summary `estimated` flags; UI callout for approximate totals |
| Soft-drain vs hard-stop confusion | Wrong button behavior | **Done:** Drain/Stop UI + `/drain` `mode` (`soft`/`hard-fallback`); failed drain no longer fakes stopped; control notice banner |
| Per-run stop skipped drain-on-stop | UI always hit hard `/runs/:id/stop` | **Done:** shared stop/drain handlers; per-run `/stop` + `/drain` parity with legacy |
| Autonomous soft-done spun forever | Soft `"done"` cleared `earlyStopDetail` and re-cycled | **Done:** `councilSettlementPolicy` — soft done is terminal; autonomy continues only via `"retry"` |
| No-op apply marked completed | Empty `filesWritten` treated as successful commit | **Done:** `WorkerPipeline` fail-closed + council worker zero-write retry |
| Blackboard zero-write approve | Auditor/propose path could complete empty work | **Done:** auditor reject zero files; proposeCommit rejects empty hunks |
| Permanent no-progress spin | Soft fail requeue forever | **Done:** `permanent:noop-exhausted` / attempts-exhausted + productive-progress gate |
| Settlement reason opaque offline | Chip empty after reload | **Done:** hydrate from `summary.stopDetail`; pipeline failure summary + earlyStopDetail |
| Token estimates look real | Fake 22k floors unlabelled | **Done:** `estimated` flag on live records + UI callout |
| Activity history missing | Sidebar only last phase | **Done:** per-agent activity ring buffer + mini timeline in AgentPanel |
| Pipeline phase fail no summary | Throw without stopDetail | **Done:** write failure summary + earlyStopDetail |
| Experimental start without ack | API accepts research presets silently | **Done:** `allowExperimental` required for experimental/research + multi-writer |
| LAN bind open | Warn-only without token | **Done:** refuse listen unless token or `SWARM_ALLOW_INSECURE_LAN=1` |
| Log dir growth | Manual prune only | **Done:** startup best-effort `prune-logs --apply` |
| Blackboard thrash with open todos | Stuck only when open=0 | **Done:** productive-progress streak on commits/met flips |
| Activity history lost on WS | Sidebar only last phase live | **Done:** client ring buffer on `setAgentActivity` + hydrate merge |
| Audit before cycle settle | Unresolved fails advance cycle | **Done:** abandon residual → permanent-skip before audit; pending-commit wait |
| Blackboard completionDetail not live | Chip empty while stuck/no-progress | **Done:** status earlyStopDetail from completionDetail |
| no-productive-progress → "completed" | Summary lies about success | **Done:** classifyStopReason maps progress gates to no-progress |
| writeMode never sent from UI | multi experimental gate unused | **Done:** SetupForm write mode + start payload |
| No-op replan thrash | Replan full 3× on zero-write | **Done:** noop stale → replan cap 1 + permanent skip |
| Debug Log list O(bytes) | Scanning every debug.jsonl | **Done:** `debug.meta.json` sidecar + optional `?limit=&offset=` |
| Brain RECONFIG after stop | Button hidden on terminal phase | **Done:** soft-terminal + 90s grace; deferred sessionStorage on 404 |
| conflictPolicy unused in UI | multi only | **Done:** SetupForm conflict policy when writeMode=multi |
| Deferred RECONFIG not applied | sessionStorage only on 404 | **Done:** next Start merges cap/rounds/token from deferred patch |
| Rotated debug ignored | List/replay only current debug.jsonl | **Done:** merge debug-*.jsonl.gz into replay + index |
| Debug Log first paint | Full list always | **Done:** client fetches `?limit=40` |
| Event log cold rescan | 45s cache only | **Done:** `event-log-index.json` mtime cache |
| Archive gunzip every open | 40 gz heads | **Done:** `archives-index.jsonl` on rotation |
| Drill-down OOM | Full run load | **Done:** `?limit=&beforeTs=` + load older UI |

## P2 — product / security / polish

| Risk | Mitigation |
|------|------------|
| Experimental presets feel “core” | **Done:** server maturity gate + UI badges |
| Multi-writer conflicts | Prefer single-writer; multi requires `allowExperimental` |
| Unauthenticated LAN bind | **Done:** fail-closed without token |
| Event log disk growth | **Done:** startup prune + rotation |
| Brain auto-provision | Off by default |

## Working principles

1. **One control plane per prompt** — manager + activity + status; no headless streams.
2. **Fail closed on composite** — pipeline phase failure stops pipeline.
3. **Primary stop gates** — empty/junk, plan-empty, caps, board stuck (not Jaccard).
4. **Reconnect honesty** — REST `/status` must carry agents + activity + streaming.
5. **Presets are products** — experimental paths get labels, not silent partial features.
