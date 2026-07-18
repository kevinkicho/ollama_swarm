# Brain OS: Agentic Dispatch Service (Run-Layer Agency)

| Field | Value |
|-------|-------|
| **Author** | Postmortem program (runs `4bd7f7f6`, `cff96fa8`, `3d0aceba`) |
| **Date** | 2026-07-18 |
| **Revision** | 1 |
| **Status** | Partially implemented (2026-07-18) — dispatch/effects/helper session + apply_miss & progress_stuck hooks; git-native write/edit/git_* tools |
| **Related docs** | [`BRAIN-OS-FOR-EXTERNAL-AGENTS.md`](../BRAIN-OS-FOR-EXTERNAL-AGENTS.md), [`ARCHITECTURE-VISION.md`](../ARCHITECTURE-VISION.md), [`known-limitations.md`](../known-limitations.md), [`productiveProgress` / tier-stuck](./cycle-integrity-and-progress-heartbeat.md) |
| **Related code (today)** | `brainOverseer/*`, `brainService.ts`, `tool coach` / `controlAdvice`, `tierRunner.ts`, `workerParseCascade.ts`, `auditorPendingCommits.ts`, `nativeToolHandlers.ts` |
| **Non-goal of this doc** | Windows Administrator / UAC elevation as the fix for tool leashes |

---

## Overview

Blackboard autonomy already works for long runs, but brittle runs show a pattern:

- **Agents want to work** (propose hunks, call tools, decline done work).
- The **run layer** applies many **micro-behavior policies** (Unix-bash coach, expectedFiles hard fence, skip LLM repair, autoApprove without content review, zero-progress ignoring open queue).
- Recovery is **scripted** (replan emit-only, permanent skip, tier-stuck) rather than **agentic**.

This design promotes **Brain OS** from a post-run librarian into a **runtime service that provides agentic labor on demand**:

1. Run layer **dispatches** a typed conflict/context pack.
2. Brain OS **recruits** one or more ephemeral agents.
3. Those agents resolve the situation with **agency** (tools + judgment within privileges).
4. Agents are **released**; structured **effects** are applied back to the run.
5. Further issues can **recruit** more agents (bounded).

We **do not** encode every recovery as a strategy enum. We hardcode only the **operating system** (dispatch, budgets, sandbox, effect application).

---

## Background & Motivation

### Evidence from recent runs

| Run | Signal | Product lesson |
|-----|--------|----------------|
| `4bd7f7f6` | 12× seed-direct/skip explore; expectedFiles rejects; autoApprove ×10; UNVERIFIED decline ×10; batch apply fail; **no-productive-progress** with 22 pending + 3 pending-commit | Micro-gates + weak recovery; progress definition ignores open work |
| `cff96fa8` | `autoApprove: true` but tool-coach still leashes Unix-via-bash; agent invented `str_replace_editor` (denied) | Trust mode ≠ host agency; tools are a fiction relative to agent intent |
| `3d0aceba` | tool-loop 0 / emit-only thrash (partly fixed); pending-commit abandoned on stop | Recovery paths too rigid |

### Current Brain role (gap)

Today (`brainOverseer.ts`):

- **Post-run** analysis, patterns, insights.
- Explicitly **not** live run control for conflict resolution.
- Exception collection is historical, not interrupt-driven.

External guide [`BRAIN-OS-FOR-EXTERNAL-AGENTS.md`](../BRAIN-OS-FOR-EXTERNAL-AGENTS.md) describes Brain as **config / steer / analyze** for *outer* agents—not an **inner** dispatch OS for the run layer.

### Hardcoding micro-behaviors vs substrate

| Kind | Examples | Direction |
|------|----------|-----------|
| **Micro-behavior scripts** | Always deny Unix bash; always skip repair on pure-think; always hard-reject non-expectedFiles | **Reduce** |
| **Substrate / OS invariants** | Clone sandbox; timeouts; typed dispatch/effects; budget caps; user-level host `run` honesty | **Keep / improve** |

**Brain OS agents invent tactics.** The product defines **how to hire them and how to absorb their results**.

---

## Goals & Non-Goals

### Goals

1. **Brain OS as a service**: `dispatch(request) → effects` with ephemeral agent sessions.
2. **Recruit / release** helpers when issues emerge (bounded concurrency and depth).
3. **No recovery strategy enum** as the primary program—agency inside the session.
4. **Typed conflict events** from the run layer (labels for routing/context only).
5. **Effect applicator** owned by the run layer (board/git/stop are not free-for-all).
6. **Compose with** existing blackboard (planner/worker/auditor remain the main factory).
7. **Honest host tools** (Windows-aware) as substrate, not admin elevation.
8. **Operator visibility**: transcript deliberation when Brain OS agents act.

### Non-Goals

1. **Windows Administrator / UAC** as a prerequisite for agent work.
2. Brain rewriting **ollama_swarm** platform source mid-run (self-upgrade of the product is out of band).
3. Replacing planner/worker/auditor with only Brain agents for all work.
4. Unbounded agent fork-bombs or unbounded token spend.
5. Guaranteeing every conflict resolves without human input (`needs_human` is valid).

---

## Key Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| **D1** | **Agency over strategy enums** | Encoding every recovery is brittle; agents generalize. |
| **D2** | **Brain OS is a runtime**, not only post-run analysis | Conflicts happen mid-run; historians cannot unstick the board. |
| **D3** | **Effects are structured and applied by the run layer** | Helpers must not race board/git without a single writer. |
| **D4** | **Labels ≠ programs** | `kind: apply_miss` routes context; it does not select a fixed script. |
| **D5** | **Budgets are hard; tactics are soft** | `maxWallMs`, `maxTokens`, `maxToolTurns`, `maxDepth`, `maxHelpersPerRun`. |
| **D6** | **Privilege tiers for helpers** | Observer → Repairer → Runner → Board officer → Arbiter (see §Privileges). |
| **D7** | **autoApprove maps to privilege elevation**, not “ignore all policy” | User trust should unlock host-run + apply under clone, not silent system admin. |
| **D8** | **Main swarm continues to own normal work** | Brain OS is interrupt-driven, not the sole executor. |
| **D9** | **Recursion allowed, depth-bounded** | Child dispatches for sub-issues; default `maxDepth = 2`. |
| **D10** | **Admin/UAC is out of scope** | Failures are product leashes + tool fiction, not missing elevation. |

---

## Proposed Design

### 1. Architecture

```
┌────────────────────────────────────────────────────────────┐
│ Blackboard run (planner / workers / auditor)                 │
│  normal turns → on conflict → BrainOS.dispatch(...)          │
└────────────────────────────┬───────────────────────────────┘
                             │ request + context pack
                             ▼
┌────────────────────────────────────────────────────────────┐
│ Brain OS                                                     │
│  Dispatcher ──► Agent pool / spawn                           │
│       │              │                                       │
│       │              ├─ Helper agent session (tools+budget)  │
│       │              └─ optional child dispatches            │
│       ▼                                                      │
│  Session result → normalize to BrainDispatchResult           │
└────────────────────────────┬───────────────────────────────┘
                             │ effects
                             ▼
┌────────────────────────────────────────────────────────────┐
│ Run-layer EffectApplicator (deterministic)                   │
│  board ops · apply/propose · notes · stop/drain              │
└────────────────────────────────────────────────────────────┘
```

**Mental model:** Brain OS is the **operating system for agentic labor**. Blackboard is the **primary application**. Helpers are **short-lived processes**.

### 2. Dispatch request (API sketch)

```typescript
// shared or server — conceptual contract

export type BrainConflictKind =
  | "tool_block"        // denied tool, coach thrash, unknown tool
  | "apply_miss"        // search_not_found / dry-run fail / batch apply fail
  | "worker_decline"    // skip / already-done claim
  | "parse_fail"        // empty / pure-think / invalid JSON after cascade
  | "progress_stuck"    // zero durable progress with open work
  | "contract_stuck"    // unmet criteria + thrash
  | "open";             // free-form (amend-driven / human steer)

export type HelperPrivilege =
  | "observer"       // read/grep/glob/list only
  | "repairer"       // + propose hunks / request apply
  | "runner"         // + host run (node/npm/git/pwsh under clone)
  | "board_officer"  // + complete/skip/post/reopen todos
  | "arbiter";       // + recommend stop/drain (applied by run layer)

export interface BrainDispatchRequest {
  runId: string;
  kind: BrainConflictKind;
  /** Optional soft label for routing/model choice — not a strategy program. */
  hints?: string[];
  context: {
    phase?: string;
    todoId?: string;
    criterionIds?: string[];
    lastErrors?: string[];
    /** Bounded slices — not full multi-MB transcript. */
    transcriptExcerpt?: string;
    boardSnapshot?: {
      pending: number;
      inProgress: number;
      pendingCommit: number;
      completed: number;
      skipped: number;
    };
    relevantFiles?: string[];
    autoApprove?: boolean;
    host?: "win32" | "darwin" | "linux";
  };
  privileges: HelperPrivilege;
  budget: {
    maxWallMs: number;
    maxTokens?: number;
    maxToolTurns: number;
    maxSubAgents: number;
    maxDepth: number; // for this subtree
  };
  /** Depth of this dispatch (0 = top-level from run layer). */
  depth: number;
  parentDispatchId?: string;
}

export interface BrainDispatchResult {
  dispatchId: string;
  status: "resolved" | "partial" | "blocked" | "needs_human";
  summary: string;
  effects: BrainEffect[];
  /** Optional child work Brain OS already ran or recommends. */
  followUpDispatches?: number; // count completed children
  usage?: { tokensIn?: number; tokensOut?: number; wallMs: number };
}

export type BrainEffect =
  | { type: "board_complete"; todoId: string; reason: string }
  | { type: "board_skip"; todoId: string; reason: string }
  | { type: "board_reopen"; todoId: string; updates?: Record<string, unknown> }
  | { type: "board_post_todos"; todos: Array<{ description: string; expectedFiles: string[] }> }
  | { type: "propose_hunks"; todoId: string; hunks: unknown[]; files: string[] }
  | { type: "request_apply"; todoId: string } // run layer applies pending-commit
  | { type: "append_system"; text: string }
  | { type: "recommend_drain" }
  | { type: "recommend_stop"; reason: string }
  | { type: "none" };
```

### 3. Agent lifecycle (recruit / work / release)

| Phase | Behavior |
|-------|----------|
| **Recruit** | Allocate session: model (default helper model from run config or Brain default), privilege tier, budget slice. |
| **Context pack** | Compress: conflict kind, last errors, file excerpts, board counts, relevant criterion text. Cap size (e.g. 32–64k chars). |
| **Work** | Normal chat+tools under privileges; same ToolDispatcher substrate as main agents. |
| **Child recruit** | Helper may call Brain OS again with `depth+1` if budget allows. |
| **Complete** | Model emits a **result envelope** (JSON) mapped to `BrainDispatchResult`. |
| **Release** | Drop session; optional memory write (lesson for this clone) is opt-in. |

**Pool vs spawn:** v1 can always spawn; later add a warm pool for latency. Semantics unchanged.

### 4. Integration points (run layer)

Wire **interrupt-driven** calls (not every turn):

| Event | `kind` | Default privilege |
|-------|--------|-------------------|
| Tool denied / coach thrash (N≥2) | `tool_block` | `runner` if autoApprove else `observer`→`repairer` |
| Apply miss unrepaired / batch apply fail | `apply_miss` | `repairer` |
| Worker decline / UNVERIFIED path | `worker_decline` | `board_officer` |
| Parse cascade exhausted | `parse_fail` | `repairer` |
| Zero durable progress streak ≥1 with open queue | `progress_stuck` | `arbiter` |
| Auditor invents scope explosion (optional later) | `contract_stuck` | `arbiter` |

**Pseudocode:**

```text
on RunConflict(event):
  if brainOsDisabled or budgetExhausted: fall back to legacy path
  result = await brainOs.dispatch(buildRequest(event))
  applyEffects(result.effects)
  if result.status == needs_human: surface UI + optional pause
  else continue main loop
```

Legacy micro-paths remain as **fallback** until Brain OS coverage is solid.

### 5. Effect applicator (deterministic)

Single writer in the run:

- Validate effects against privileges used in the dispatch.
- Apply board mutations via existing `TodoQueueWrappers`.
- Apply hunks via existing apply pipeline (no second invent-apply path).
- `recommend_stop` / `recommend_drain` → existing lifecycle APIs.
- Emit transcript: `[brain-os] dispatch … status=…` + deliberation record.

### 6. Privileges & autoApprove mapping

| Privilege | Tools (illustrative) | Board | Host run |
|-----------|----------------------|-------|----------|
| observer | read, grep, glob, list | no | no |
| repairer | + propose_hunks | no (propose only) | no |
| runner | + host `run` / honest shell | no | yes (allowlisted) |
| board_officer | repairer tools | complete/skip/post | optional |
| arbiter | board_officer | + stop/drain recommend | optional |

| Run config | Privilege elevation |
|------------|---------------------|
| default | repairer for apply/decline; observer for advisory |
| `autoApprove: true` | repairer→runner for tool_block/apply_miss; board_officer for decline |
| explicit `brainOs.privilegeCap` | hard ceiling |

### 7. Budgets & anti-fork-bomb

| Knob | Suggested default (v1) |
|------|------------------------|
| `maxDepth` | 2 |
| `maxHelpersPerRun` | 8 |
| `maxConcurrentHelpers` | 2 |
| `maxWallMs` per dispatch | 3–10 min (config) |
| `maxToolTurns` | 20–40 (not 0) |
| Global Brain OS token share | e.g. ≤20% of run token budget |

When budget exceeded: `status: blocked` + legacy fallback or stop with reason.

### 8. Host compute honesty (substrate, not admin)

Brain OS helpers inherit the same tool layer. Separately (can land in parallel PRs):

- Prefer **Windows-native `run`** (`node`, `npm`, `npx`, `git`, `pwsh`) over Unix-fiction `bash` on win32.
- Do **not** require Administrator; clone-scoped user rights are enough.
- Micro-coaches for Unix CLI can be **delegated** to a `tool_block` dispatch instead of hard deny-only.

### 9. Observability

- Transcript system lines: dispatch start/end, helper agent id, status, effect summary.
- `controlAdvice` / deliberation: `layer: brain_os`.
- Summary field (optional): `brainOs: { dispatches, resolved, blocked, tokens, helpersSpawned }`.
- Event log types: `brain_os_dispatch_start`, `brain_os_dispatch_end`.

### 10. Failure modes

| Failure | Behavior |
|---------|----------|
| Helper pure-think / empty | Retry once with emit-only result schema; then `blocked` |
| Helper wants illegal effect | Applicator rejects; note in summary |
| Deadlock with main workers | Board lock: pause worker claims on shared todos during dispatch (or serialize apply) |
| Infinite mutual recruit | depth + maxHelpers |

---

## Alternatives Considered

| Alternative | Why not primary |
|-------------|-----------------|
| **Strategy enum arbiter** | Re-encodes micro-behaviors; fails on novel conflicts |
| **Only more tool coaches** | More leashes; agents still cannot resolve |
| **Admin elevation** | Does not add grep/sed; expands blast radius |
| **Replace blackboard with only Brain agents** | Throws away working factory loop; cost/control harder |
| **Post-run Brain only (status quo)** | Cannot unstick live runs |

---

## Migration Plan

### Phase 0 — Spec & metrics (this doc)

- Land design; add summary counters stub optional.

### Phase 1 — Skeleton — **landed (partial)**

- `BrainOS.dispatch` interface + in-process implementation (`server/src/swarm/brainOs/`).
- Effect applicator for a **subset** of effects (`append_system`, `board_skip`, `board_complete`, `propose_hunks`, …).
- Feature flag: `brainOs` on run config (defaults on when `autoApprove`).

### Phase 2 — First interrupt — **landed**

- Wire `apply_miss` unrepaired dry-run **and** `worker_decline` UNVERIFIED.
- Compare against legacy: resolution rate, tokens, wall time (still needed in production runs).

### Phase 3 — Expand events — **landed (partial)**

- `progress_stuck`, `tool_block` (coach thrash), `apply_miss`, `worker_decline` landed.
- Child dispatches (depth 1, shared budget) + `summary.brainOs` metrics landed.
- Batch apply fail interrupt still open.

### Phase 4 — Substrate honesty — **landed (partial)**

- **Git-native working tree:** write/edit/git_status/git_diff tools; workers finish with
  `{workingTree:true}`; orchestrator commits disk reality (no re-apply no-op).
- Host **`run`** tool (preferred name; `bash` alias) + more Unix→in-process rewrites on win32.
- Further pwsh-first shell policy optional.

### Phase 5 — Default on for trusted local runs — **landed**

- Enable when `autoApprove` or explicit `brainOs: true`.
- Deprecate redundant micro-coaches that only duplicate Brain OS work (ongoing).

---

## Testing Strategy

| Level | Cases |
|-------|-------|
| Unit | Effect applicator privilege checks; budget/depth gates; result JSON parse |
| Integration | Synthetic apply_miss → dispatch → complete todo; decline → verify → skip |
| Fixture runs | Replay transcript slices from `4bd7f7f6` / `cff96fa8` conflict points |
| Regression | Flag off → legacy path unchanged |
| Cost | Cap helpers; assert maxHelpers not exceeded under thrash |

---

## Open Questions

1. **Model for helpers:** same as auditor, dedicated `brainHelperModel`, or cascade (cheap then strong)?
2. **Should helpers share the same session store as run agents** or isolated sessions only?
3. **Board lock granularity:** whole run vs per-todo vs per-file?
4. **Memory:** write lessons mid-run or only on release?
5. **UI:** show helper agents in Active Runs roster or only as system bubbles?

---

## PR Plan

### PR1 — Contracts + flag

- **Title:** `feat(brain-os): dispatch request/result types + feature flag`
- **Affects:** `shared/` types, config schema, docs
- **Depends on:** none
- **Desc:** Types, empty no-op dispatcher, config `brainOs: { enabled, maxHelpersPerRun, ... }`

### PR2 — Effect applicator

- **Title:** `feat(brain-os): deterministic effect applicator`
- **Affects:** blackboard wrappers, transcript append
- **Depends on:** PR1
- **Desc:** Apply board/system effects with privilege checks; tests

### PR3 — In-process helper session

- **Title:** `feat(brain-os): spawn helper agent session for dispatch`
- **Affects:** `brainOverseer` or new `brainOs/`, `chatOnce`, ToolDispatcher
- **Depends on:** PR2
- **Desc:** Recruit one agent, context pack, result JSON, release; no run wiring yet

### PR4 — Wire apply_miss (or decline) interrupt

- **Title:** `feat(brain-os): dispatch on unrepaired apply miss`
- **Affects:** worker self-consistency / apply path
- **Depends on:** PR3
- **Desc:** Replace fail-todo-only with dispatch when flag on; fallback legacy

### PR5 — progress_stuck before tier-stuck

- **Title:** `feat(brain-os): dispatch on zero-progress with open queue`
- **Affects:** `tierRunner.ts`, `productiveProgress.ts`
- **Depends on:** PR3
- **Desc:** One Brain OS chance to drain/re-scope before hard stop

### PR6 — tool_block + host run honesty (parallelizable)

- **Title:** `feat(tools): Windows-honest run tool; brain-os on tool_block`
- **Affects:** `nativeToolHandlers.ts`, profiles, tool coach
- **Depends on:** PR3 optional
- **Desc:** Reduce Unix-bash fiction; optional dispatch when tools blocked

### PR7 — Child recruit + observability

- **Title:** `feat(brain-os): child dispatches + summary metrics`
- **Affects:** dispatcher, summary, UI bubbles
- **Depends on:** PR4–5
- **Desc:** maxDepth, counters, transcript deliberation polish

---

## Key Decisions (summary)

1. **Agency over strategy enums** — helpers decide how; OS defines dispatch/effects/budgets.  
2. **Interrupt-driven Brain OS** — not a replacement for the main swarm factory.  
3. **Structured effects + single applicator** — safe integration with board/git.  
4. **Bounded recruit/release** — autonomy without fork bombs.  
5. **Trust elevates privileges, not admin rights** — user-level host compute under clone.  
6. **Labels only for context** — conflict kinds are not recovery programs.

---

## References

- Runs: `4bd7f7f6-ebc2-412e-a88f-a8f1eeb0c0db`, `cff96fa8-42ea-468c-829f-22be01038a70`, `3d0aceba-95b9-48a1-b986-65359a528475`
- Code: `server/src/swarm/blackboard/brainOverseer/brainOverseer.ts` (post-run only today)
- Code: `server/src/tools/nativeToolHandlers.ts` (`bashTool`, Windows Unix deny/rewrite)
- Code: `server/src/swarm/productiveProgress.ts`, `tierRunner.ts` (zero-progress ignores openΔ)
- Code: `server/src/swarm/blackboard/prompts/worker.ts` (expectedFiles allowlist)
- Code: `server/src/swarm/blackboard/workerParseCascade.ts` (skip LLM repair)
