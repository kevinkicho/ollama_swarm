# Plan: Fix Nudge System — Use Active Run ID Instead of Stale Viewing ID

## Problem

When a user views a previous run's data (via review mode `?review=<runId>&path=...`)
or when the WebSocket store hasn't updated to the latest run, the nudge button
sends the **wrong run ID** to the server. The server rejects it with:

```
"No active run with that runId, or text was empty"
```

This happens because:
1. The `AmendButton` sends `runId` from the store, which may be a reviewed run
2. The orchestrator checks `this.runId !== runId` — only the current active run is accepted
3. In review mode, the store holds the reviewed run's ID, not the active run

## Current Flow

```
Store.runId = "d32fd98e" (reviewed run, stale)
  → AmendButton sends POST /api/swarm/amend { runId: "d32fd98e", text: "..." }
  → orch.addAmendment("d32fd98e", "...")
  → orch.runId is "b55d92c0" (current active run)
  → this.runId !== runId → returns null → 404 error
```

## Solution: Three Approaches

### Option A: Fetch Active Run ID on Submit (Recommended)

When the user clicks "Submit nudge", first fetch the current active run ID from the server,
then POST with that ID. This ensures the nudge always targets the live run.

```typescript
const onSubmit = async () => {
  // 1. Get the active run ID from the server
  const statusRes = await fetch("/api/swarm/status");
  const status = await statusRes.json();
  const activeRunId = status.runId;
  if (!activeRunId) throw new Error("No active run on server");

  // 2. POST with the active run ID
  const res = await fetch("/api/swarm/amend", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runId: activeRunId, text: trimmed }),
  });
  ...
};
```

**Pros:**
- Always gets the correct active run ID
- Works regardless of review mode or stale store state
- Simple implementation (2 extra lines)

**Cons:**
- Adds one extra HTTP request per nudge (cheap — `/api/swarm/status` is instant)
- The nudge could theoretically race with a run transition, though unlikely in practice

### Option B: Server-Side Fallback

When `addAmendment` receives a non-matching runId, accept it anyway if the runId
looks valid (format exists in recent history). This is more complex and could
lead to ambiguous nudge targeting.

**Not recommended** — too permissive, could cause confusion.

### Option C: Store Active Run ID Separately

Add a separate `activeRunId` field to the store that's updated by `run_started`
WS events. The `AmendButton` uses `activeRunId` instead of the viewing runId.

```typescript
// In store.ts
interface State {
  runId: string;        // The run we're viewing (for review/replay)
  activeRunId: string;  // The currently-active run on the server
}
```

**Pros:**
- No extra HTTP request
- Always up-to-date via WS events

**Cons:**
- Requires store change (new field + WS handler)
- In review mode, `activeRunId` and `runId` diverge — must be careful which one to use

## Recommendation: Option A (simplest, most reliable)

The extra `/api/swarm/status` call is cheap (sub-millisecond, no model invocation).
It's the most reliable approach because it always gets the truth from the server,
regardless of what state the frontend is in.

## Files to Change

1. **`web/src/components/IdentityStrip.tsx`** — In the `onSubmit` function, fetch
   `/api/swarm/status` to get the active runId before POSTing to `/api/swarm/amend`.

## Implementation

```typescript
// In IdentityStrip.tsx AmendButton.onSubmit():

const onSubmit = async () => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return;
  setBusy(true);
  setError(null);
  try {
    // Fetch the active run ID from the server — this ensures the
    // nudge targets the currently-running run, not a reviewed/stale one.
    const statusRes = await fetch("/api/swarm/status");
    if (!statusRes.ok) throw new Error(`Server status: HTTP ${statusRes.status}`);
    const status = (await statusRes.json()) as { runId?: string };
    const activeRunId = status.runId;
    if (!activeRunId) throw new Error("No active run on server");

    const res = await fetch("/api/swarm/amend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: activeRunId, text: trimmed }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    setText("");
    setOpen(false);
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
  } finally {
    setBusy(false);
  }
};
```

## Testing

1. Start a run, get the runId
2. Open a second browser tab pointing to the review URL (`/?review=<runId>&path=...`)
3. Start a NEW run (different runId)
4. On the review tab, click "+ nudge" and submit text
5. Verify the nudge is accepted (no 404) — the fix fetches the active runId from `/api/swarm/status`
