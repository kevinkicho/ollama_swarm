# Brain OS Dispatch API Sketch (Companion)

| Field | Value |
|-------|-------|
| **Parent** | [`brain-os-agentic-dispatch.md`](./brain-os-agentic-dispatch.md) |
| **Date** | 2026-07-18 |
| **Status** | Sketch — implement in PR1–PR3 |

Companion to the main design: **module layout**, **suggested TypeScript surfaces**, and **example scenarios**. Normative decisions live in the parent doc.

---

## Module layout (proposed)

```text
server/src/swarm/brainOs/
  types.ts              # re-export or mirror shared contracts
  dispatcher.ts         # BrainOS.dispatch implementation
  contextPack.ts        # build bounded context from run snapshot
  helperSession.ts      # spawn chat+tools session, parse result envelope
  pool.ts               # optional warm pool (v2)
  budgets.ts            # run-level counters (helpers, tokens, depth)
  effects/
    applyEffects.ts     # privilege-checked applicator
    validateEffects.ts
  index.ts

shared/src/brainOs/
  dispatchTypes.ts      # BrainDispatchRequest / Result / Effect
  conflictKinds.ts
```

Keep **blackboard** free of heavy Brain logic: thin adapter

```text
server/src/swarm/blackboard/brainOsAdapter.ts
  dispatchFromRun(ctx, event) → BrainOS.dispatch(...)
```

---

## Feature flag / config

```typescript
// conceptual RunConfig / start body
brainOs?: {
  enabled?: boolean;              // default false until Phase 5
  maxHelpersPerRun?: number;      // default 8
  maxConcurrentHelpers?: number;  // default 2
  maxDepth?: number;              // default 2
  maxWallMsPerDispatch?: number;  // default 600_000
  maxToolTurnsPerDispatch?: number; // default 30
  helperModel?: string;           // default: auditorModel || model
  privilegeCap?: HelperPrivilege; // ceiling even under autoApprove
};
```

---

## Helper system prompt (sketch)

```text
You are a Brain OS helper agent for ollama_swarm.

You were recruited to RESOLVE a run-layer conflict, not to expand product scope.
Use tools within your privileges. Prefer proof on disk over speculation.

When finished, emit ONLY a JSON object:
{
  "status": "resolved" | "partial" | "blocked" | "needs_human",
  "summary": "one paragraph",
  "effects": [ /* BrainEffect objects from the schema */ ]
}

Do not invent new long-term product criteria. Do not escape the clone path.
If you need another specialist, set status partial and describe the need in summary
(the OS may spawn a child — you do not spawn recursively yourself in v1).
```

v1: **no mid-session child spawn from the model**; parent dispatcher may open a child after partial. v2: optional tool `brain_os_recruit`.

---

## Example scenarios

### A. Apply miss (from `4bd7f7f6`)

**Trigger:** unrepaired dry-run fail → would have `failing todo (not proposing)`.

**Request:** `kind: apply_miss`, privileges `repairer`, files + last miss report.

**Helper agency:** read current file → rewrite anchors → `propose_hunks` effect.

**Applicator:** proposeCommitQ or apply path.

### B. Tool block (from `cff96fa8`)

**Trigger:** tool coach Unix-bash thrash; or denied `str_replace_editor`.

**Request:** `kind: tool_block`, privileges `runner` if autoApprove.

**Helper agency:** use `read`/`grep` or host `run` with Windows-available commands; return effects that advance the **original todo**, not a lecture.

### C. Progress stuck

**Trigger:** zero durable progress streak ≥1, board has pendingCommit > 0 or pending > 0.

**Request:** `kind: progress_stuck`, privileges `arbiter`.

**Helper agency:** inspect pending-commit; recommend drain/apply or skip dead todos; effect `request_apply` / `board_skip` / `recommend_drain`.

**Run layer:** if still stuck after dispatch, then legacy tier-stuck stop.

### D. Worker decline

**Trigger:** UNVERIFIED refusal path.

**Request:** `kind: worker_decline`, privileges `board_officer`.

**Helper agency:** list/read expected files; if done → `board_complete` or `board_skip` with reason; if not → `board_reopen` with better anchors.

---

## Sequence: single dispatch

```text
Worker ──fail──► blackboard
                    │
                    ▼
              brainOsAdapter
                    │
                    ▼
              budgets.allow?
                    │ no ──► legacy path
                    │ yes
                    ▼
              contextPack.build
                    │
                    ▼
              helperSession.run (tools)
                    │
                    ▼
              parse result JSON
                    │
                    ▼
              applyEffects
                    │
                    ▼
              transcript + metrics
                    │
                    ▼
              continue run loop
```

---

## Metrics (summary.brainOs)

```typescript
interface BrainOsRunMetrics {
  dispatches: number;
  resolved: number;
  partial: number;
  blocked: number;
  needsHuman: number;
  helpersSpawned: number;
  childDispatches: number;
  tokensIn: number;
  tokensOut: number;
  wallMs: number;
  effectsApplied: number;
  effectsRejected: number;
}
```

---

## Compatibility with external Brain guide

[`BRAIN-OS-FOR-EXTERNAL-AGENTS.md`](../BRAIN-OS-FOR-EXTERNAL-AGENTS.md) remains valid for **outer** control (start/steer/stop).

This design adds **inner** Brain OS:

| Outer (existing) | Inner (this design) |
|------------------|---------------------|
| External agent / user drives APIs | Run layer drives `dispatch` |
| Chat / amend / reconfig | Conflict resolution sessions |
| Post-run proposals | Mid-run effects |

Document both under the Brain OS umbrella; do not conflate endpoints until a unified control-surface entry is added (optional follow-up: `POST /api/swarm/brain/dispatch` for debugging).
