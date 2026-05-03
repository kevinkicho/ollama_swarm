# V2 Step 6c — UI cuts over to event-log-derived state

**Status:** in progress (foundation + first thin slice shipped 2026-04-29 → 2026-05-01)
**Owner:** unassigned (next session, ~1–2 days)

---

## Goal

Replace every WebSocket-driven UI state path with derivation from `logs/current.jsonl`. After cutover, the UI:

- can render any past run from log alone (no WS needed)
- has a single source of truth — the JSONL is what the server writes; the WS becomes a *transport* not a *truth*
- is offline-replayable for debugging without dev server

---

## What's already shipped

| Slice | Commit | What it gives |
|---|---|---|
| `useEventLogStream` hook (poll) | shipped 2026-04-29 | UI can subscribe to aggregated per-run summaries from `/api/v2/event-log/runs` |
| `EventLogMirrorPanel` (debug-only at `?eventLogMirror=1`) | shipped 2026-04-29 | side-by-side WS-store ↔ event-log diff so drift surfaces early |
| `?useEventLogRunId=1` field cutover | shipped 2026-04-29 | one specific field reads from event log instead of WS — pattern proof |
| `GET /api/v2/event-log/runs/:runId` | shipped 2026-05-01 | per-run record replay endpoint; unblocks any UI panel that needs the FULL record stream for one run |
| Provider streaming bug fix | shipped 2026-05-01 (`eff8c4f`) | unrelated discovery, but: paid-provider streaming was broken until this fix. Multi-provider claims pre-2026-05-01 were partially false. |

---

## What still needs to happen (the actual cutover)

1. **Live SSE endpoint** for in-flight events: `GET /api/v2/event-log/stream?runId=...` that emits each new JSONL line as it's written. Without this, the UI still depends on the WS for live runs. **~3h.**

2. **`useRunEventStream(runId)` hook** that subscribes to the SSE endpoint, reduces records into derived state, and re-renders. Wraps a `deriveRunState`-like reducer that mirrors what `RunStateObserver.ts` does on the server. **~4h.**

3. **WS dispatch handlers → event-log-derived equivalents.** Map every dispatch in `web/src/hooks/useSwarmSocket.ts` to its event-log derivation. Roughly:
   - `transcript_append` → `records.filter(r => r.event.type === "transcript_append")`
   - `agent_state` → fold by agentId, latest wins
   - `swarm_state` → latest phase from records
   - `run_summary` → terminal record's `summary`
   - `agents_ready` summary → derive from `agent_state` events
   **~6h, tested incrementally.**

4. **Cut over the store one slice at a time** — add `?useEventLogStream=1` URL flag (mirror the existing `?useEventLogRunId=1` pattern). Each slice cutover lands behind the flag, then the flag flips to default-on once `EventLogMirrorPanel` shows zero drift across a full tour. **~2h per slice × 5 slices.**

5. **Delete WS dispatch code.** Final step. Once event-log-derived state has driven a real run end-to-end with no drift, remove the WS handlers. The WS stays as a *kick* signal ("a record was written, refetch") but stops carrying state. **~2h.**

---

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Event log has different shape than WS dispatches (some fields may be missing) | The mirror panel exists exactly to catch this. Land each slice behind a flag; tour-validate with mirror open before flipping default. |
| SSE connection drops mid-run leave UI stuck | Auto-reconnect with exponential backoff (already a pattern in `useSwarmSocket.ts`). On reconnect, refetch full record stream and re-derive — idempotent because reducer is pure. |
| File-tail SSE has Windows path quirks | Test on Windows first — `fs.watch` semantics differ from Linux. May need polling fallback. |
| Event log misses events the WS emitted directly | Audit pass: grep `broadcaster.broadcast(...)` calls; for each, verify the event also lands in `logs/current.jsonl` via `eventLogger.log(...)`. Backfill any gaps before cutover. |

---

## Suggested order of attack

1. **Audit pass** (~30 min): grep `broadcaster.broadcast` + `eventLogger.log`. Are they 1:1 or does WS emit anything the log misses? Fix gaps now.
2. **SSE endpoint + `useRunEventStream` hook** (~7h together). Lands behind `?useRunEventStream=1`. EventLogMirrorPanel extends to compare WS-store vs the new hook for the LIVE run.
3. **Run a 5-min blackboard tour with both panels open** — should show zero drift across all 8 fields. If drift, fix before continuing.
4. **Slice cutovers** (~10h, 5 slices). One PR per slice. Each PR keeps both paths alive behind `?useEventLogStream=1` flag.
5. **Tour all 10 presets with flag default-on** — overnight or in a focused 3-hour session. Any drift = file-and-fix before next slice.
6. **Delete WS state-dispatch code** (~2h). Keep the WS for kick-signal only.

---

## When to NOT do this

- If a major V1→V2 substrate piece is mid-flight, finish that first — V2 6c assumes V2 substrate is stable.
- If active feature work is touching `useSwarmSocket.ts` heavily, defer until that lands.
- If the project is in "ship features, not refactor" mode.

The scoreboard sweep + #231 work didn't touch `useSwarmSocket.ts`, so the path is clear as of 2026-05-01.
