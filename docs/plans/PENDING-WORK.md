# Pending Work — Historical (Archived Plans)

> Most items from early archived plans have shipped. See `docs/active-work.md` for current queue.
> This file is kept for archaeology only.

Generated: 2026-06-30 (historical)

## Previously Completed Items

Items from archived plans that were implemented:

### Context Window Utilization (Plan 4) — COMPLETE ✅
- `planner.ts`: README limit scaled by model budget (4K→20K for 1M models)
- `auditor.ts`: file state + transcript limits scaled by model budget
- `councilPromptHelpers.ts`: repo file limits scaled by model budget
- `firstPassContract.ts`: README + repo file limits scaled by model budget

### Council Bug Fixes (Plan 5) — COMPLETE ✅
- `synthesizeStandup`: now parses output and posts todos to queue
- `synthesizeStandup`: fix leaked AbortController
- `synthesizeStandup`: log errors instead of silently swallowing
- Deleted dead `tryBrainFallbackWorker` function
- Removed unreachable `unmetCount === 0` check
- `parseJsonArrayFromResponse`: use balanced extraction instead of greedy

### Nudge Fix (Plan 6) — COMPLETE ✅
- `AmendButton` fetches active runId from `/api/swarm/status` before posting
