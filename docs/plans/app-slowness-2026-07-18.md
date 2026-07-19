# App slowness investigation (2026-07-18)

## Precommit / push

Working tree was already clean and `main` matched `origin/main` before this
perf slice. Follow-up commits in this pass address measured bottlenecks.

## What made the app feel “very slow”

Measured on this workspace:

| Signal | Value |
|--------|------:|
| Per-run `debug.jsonl` corpus | **~851 MB** across **95** run dirs (53 runs >5 MB) |
| `logs/current.jsonl` | **~23.5 MB** |
| Long BB run (a846871e) | **~14 MB**, **36k** event lines |
| Status hydrate (pre-compact era) | **5–6 MB** full transcript JSON (fixed earlier with `compactStatusForHttp`) |

### Ranked causes

1. **UI transcript prep O(n²)** (`prepareTranscriptForDisplay`)  
   Nested scan + `findIndex` per entry. On 8k–30k bubbles this re-ran on every
   append and froze React (hundreds of ms to multi-second).  
   **Fix:** O(n) supersede + orphan attach (`transcriptDisplayFilter.ts`).

2. **HTTP status / hydrate payload**  
   Even after tailing, 80 × 6k-char bubbles ≈ 480k chars plus board/agents.  
   **Fix:** tighter caps (tail 60, entry 3.5k, total 220k); static import of
   compact (no dynamic import on every poll).

3. **`status()` cloned the full transcript array** (`[...transcript]`)  
   Cheap vs stringify, but wasteful on every poll/cleanup with 10k–30k entries.  
   **Fix:** share live array reference; compact always slices into a new array
   for HTTP (never mutates live).

4. **Disk log growth** (operator-side)  
   Event Log / Debug Log / listActive still walk a large `logs/` tree.  
   **Mitigation:** `npm run prune-logs:apply` / `prune-runs:apply`; prefer
   Debug Log only when needed.

5. **Live run cost (not a UI bug)**  
   Multi-agent tool loops, auditor, replan, web tools — wall clock dominated by
   model/tool latency. Disk-first / tab inventory reduce *thrash*, not model RTT.

## Commands

```bash
npm run prune-logs:apply   # reclaim disk + list speed
npm run smoke:tab          # offline reliability smoke
npm run validate:grounding
```

## Still optional

- Cap board todos/findings in status if boards exceed ~500 items  
- Virtualizer: further reduce overscan on live-only views  
- Event-log list: ensure meta sidecar used when all 95 dirs present  
