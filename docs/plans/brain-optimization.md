# Plan 6: Brain Optimization — Faster, More Accurate Analysis

## Problem

The brain needs to analyze interaction chains, exception patterns, and generate
patch-ready proposals. But:

1. **Slow** — analyzing 47 exceptions across 12 chains takes 30s–5min. User waits.
2. **Redundant** — re-analyzes patterns that were already identified in prior runs.
3. **Wasteful** — regenerates all patches even when only one changed.

## Three Optimizations

### 1. Better Prompts with More Context

The current brain prompt is minimal:
```
You are a JSON extraction assistant. A planner agent produced output that failed
structured parsing. The output was supposed to conform to this schema: ...
Extract the structured data from this output.
```

This is a **dumb decoder** — it has no context about the project, the run, or
the system. For the overseer role, the brain needs:

**Current brain (parse fallback):**
- Input: raw output text (8KB) + schema description
- Output: valid JSON
- Context: none

**Proposed brain (system overseer):**
- Input: interaction chains + exception patterns + prior improvements + run summary
- Output: analysis + patch-ready proposals
- Context: full project state

The overseer prompt should include:

```
=== CURRENT RUN SUMMARY ===
Preset: blackboard | Model: deepseek-v4-flash:cloud | Duration: 4h 21m
Commits: 264 | Files changed: 47 | Todos: 520 total (264 committed, 256 skipped)
Contract: 245 criteria (243 met, 2 wont-do)

=== INTERACTION CHAINS (this run) ===
Chain 1: todo t1 "Add UNHCR row"
  - worker_skip: "section not in windowed view"
  - replanner_skip: "file reorganized"
  - auditor_accept: "wont-do: section removed"
Chain 2: todo t5 "Add ILO panel"
  - worker_skip: "panel already exists"
  - replanner_revise: "Register existing panel"
  - worker_retry_success: "panel registered"
  - auditor_accept: "met"

=== EXCEPTION PATTERNS (this run) ===
- 12 worker declines due to windowed file view
- 8 replanner skips due to file reorganization
- 3 empty responses from worker

=== PRIOR IMPROVEMENTS (from .swarm-improvements/) ===
Already implemented:
- Auto-anchor for large files (Plan 3)
- Degenerate contract filter
Pending:
- Worker context files (Plan 2)

=== RECENT INTERACTION CHAINS (from prior runs) ===
[Last 10 chains from .swarm-improvements/interaction-chains.jsonl]

=== YOUR TASK ===
1. Analyze patterns — what's causing the most failures?
2. Identify root causes — not just symptoms
3. Generate concrete patches — search/replace hunks for each fix
4. Prioritize — high/medium/low based on impact and effort
```

### 2. Cached Pattern Detection

Instead of re-analyzing all exceptions from scratch, cache pattern fingerprints:

**Pattern fingerprint:** A hash of (exception_type + reason + affected_component).

```typescript
interface PatternCache {
  /** Pattern fingerprint → cached analysis result */
  patterns: Map<string, CachedPattern>;
  /** Last analysis timestamp */
  lastAnalyzedAt: number;
  /** Run ID of last analysis */
  lastRunId: string;
}

interface CachedPattern {
  fingerprint: string;
  count: number;              // how many times seen
  firstSeen: number;          // timestamp
  lastSeen: number;           // timestamp
  rootCause: string;          // brain's analysis (cached)
  proposal?: ImprovementProposal;  // cached proposal (if generated)
  confidence: number;         // 0-1
}
```

**How caching works:**

1. During run: exception collector builds fingerprints
2. Post-run: brain checks each fingerprint against cache
3. If fingerprint exists AND count > threshold → use cached analysis (fast)
4. If fingerprint is new OR count changed significantly → re-analyze (slow)
5. After analysis: update cache with new results

**Storage:** `.swarm-improvements/pattern-cache.json`

```json
{
  "patterns": {
    "worker_decline|section not in windowed view|replanManager.ts": {
      "fingerprint": "worker_decline|section not in windowed view|replanManager.ts",
      "count": 12,
      "firstSeen": 1782757751941,
      "lastSeen": 1782775385295,
      "rootCause": "Planner doesn't declare expectedAnchors for large files",
      "proposal": { "title": "Auto-anchor for replanner", ... },
      "confidence": 0.95
    }
  },
  "lastAnalyzedAt": 1782775385295,
  "lastRunId": "d32fd98e"
}
```

**Speed benefit:** If 40 of 47 exceptions match cached patterns, the brain only
needs to analyze 7 new ones. Analysis time drops from 30s–5min to 5s–30s.

### 3. Incremental Patch Updates

Instead of regenerating all patches from scratch, track which files changed since
the last patch generation:

```typescript
interface PatchCache {
  /** File path → last known content hash */
  files: Map<string, string>;  // path → content hash
  /** Generated patches keyed by proposal ID */
  patches: Map<string, GeneratedPatch>;
  /** Last generation timestamp */
  lastGeneratedAt: number;
}

interface GeneratedPatch {
  proposalId: string;
  file: string;
  hunks: Hunk[];
  contentHash: string;  // hash of file at generation time
  verified: boolean;    // whether search anchors were validated
}
```

**How incremental updates work:**

1. Brain generates patches for all proposals
2. Each patch stores the content hash of the target file at generation time
3. Next run: brain reads current file content
4. If content hash matches cached hash → patch is still valid (fast path)
5. If content hash changed → regenerate patch for that file only
6. If proposal was marked "applied" → skip entirely

**Speed benefit:** If 3 of 4 patches target files that haven't changed, only
1 patch needs regeneration. Patch generation time drops from 10s–60s to 2s–10s.

## Combined Flow

```
Run completes
  │
  ▼
Brain reads .swarm-improvements/pattern-cache.json
  │
  ├─ Exception fingerprint matches cache? → use cached analysis (fast)
  │  New exception? → analyze with LLM (slow, but only for new patterns)
  │
  ▼
Brain reads .swarm-improvements/patch-cache.json
  │
  ├─ Patch file unchanged? → reuse cached hunks (fast)
  │  Patch file changed? → regenerate hunks (slow, but only for changed files)
  │
  ▼
Brain writes updated caches
  │
  ▼
Brain presents proposals to UI
```

## Estimated Speedup

| Scenario | Current | Optimized |
|----------|---------|-----------|
| 47 exceptions, all cached | 30s–5min | 2s–5s |
| 47 exceptions, 7 new | 30s–5min | 5s–30s |
| 4 proposals, all files unchanged | 10s–60s | 1s–3s |
| 4 proposals, 1 file changed | 10s–60s | 3s–15s |
| Cold start (no cache) | 40s–6min | 30s–5min |

## Files to Create

1. `server/src/swarm/blackboard/brainOverseer/patternCache.ts` — Pattern fingerprinting + cache
2. `server/src/swarm/blackboard/brainOverseer/patchCache.ts` — Patch caching + incremental updates

## Files to Modify

1. `server/src/swarm/blackboard/brainOverseer/brainOverseer.ts` — Use caches in analysis
2. `server/src/swarm/blackboard/brainOverseer/prompt.ts` — Richer context in prompts
3. `server/src/swarm/blackboard/brainOverseer/interactionTracker.ts` — Build fingerprints from chains
4. `server/src/swarm/blackboard/lifecycleRunner.ts` — Wire caches into post-run flow
