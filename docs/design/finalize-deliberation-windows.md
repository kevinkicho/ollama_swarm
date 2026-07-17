# Stream Finalize Completeness, Deliberation Structure, and Windows Host Reliability (RR-E)

| Field | Value |
|-------|-------|
| **Author** | Residual reliability program |
| **Date** | 2026-07-17 |
| **Revision** | 1 |
| **Status** | Proposed |
| **Program** | [`residual-reliability-program.md`](./residual-reliability-program.md) (RR-E) |
| **Depends on** | None hard; parallel to RR-B/C/D after RR-A preferred for quieter runs |
| **Related code** | `finalizeAgentOutput.ts`, runner `stripAgentText` call sites, `jsonFormatSniff.ts`, `deliberation/*`, `councilSynthesis.ts`, `ToolDispatcher.ts`, `agentBashBackoff.ts`, `scripts/dev.mjs` |
| **Related runs** | `9f449937` stream balloon; deliberation feature land; Windows tool thrash |

---

## Overview

Three **secondary amplifiers** of residual cycle waste:

1. **`finalizeAgentOutput` is not universal** — non-council / synthesis paths still use bare `stripAgentText` without loop collapse, hard caps, or integrity events.
2. **JSON format sniff** is worker-centric — auditor/replanner/standup JSON roles can still stream pure-`<think>` until wall.
3. **Deliberation is optional freeform** — DENY rarely shapes execution mid-cycle.
4. **Windows bash** rewrites simple commands but pipelines/`&&` still thrash tool loops.

RR-E completes stream safety, tightens JSON roles, makes deliberation operational where vote reconcile is on, and reduces Windows host thrash.

---

## Background & Motivation

### Finalize holdouts (post-9f449937)

| Path | File (representative) | Uses finalize? |
|------|------------------------|----------------|
| Council worker / discussion agent | council / discussion runners | Yes |
| Blackboard worker util | runnerUtil | Yes (typical) |
| Council synthesis | `councilSynthesis.ts` | **No** (strip only) |
| MoA / Map-reduce / Debate / OW / OW-deep / RR synth / Stigmergy | respective runners | **No** |

Risk: balloon class returns on other presets or large synthesis replies; `streamIntegrity` under-counts.

### JSON sniff residual

Wired for council/blackboard workers (`formatExpect: "json"`). Auditor / replanner / contract / standup-merge JSON still pay full think streams before fail (historical auditor think-only rejects).

### Deliberation residual

- Log + seed DENY/APPROVE + filter re-plans exist.
- ```deliberate``` optional → empty peer standings → vote override rare.
- DENY does not always block mid-cycle execution of same expectedFiles.
- UI shows event tail, not “why todo dropped.”

### Windows residual

- Simple `grep|cat|ls` rewrite + fail-closed Unix binaries: shipped.
- Pipes / `&&` / verifyCommand Unix assumptions: still thrash.
- esbuild/npm WSL footgun: docs-only.

---

## Goals & Non-Goals

### Goals

1. **Every agent text transcript_append** goes through `finalizeAgentOutput` (+ anomaly → stream integrity).
2. **JSON roles** (auditor, replanner, standup merge, contract extract) use think-aware `formatExpect: "json"` sniff.
3. **Vote reconcile** requires structured disposition/vote rationales (not only freeform fences).
4. DENY drops emit **operator-visible reason**; repair prompts see DENY patterns.
5. Windows: expand rewrite table; friendlier verifyCommand on win32.

### Non-Goals

1. Reviving Jaccard primary stop.
2. Full PowerShell script transpiler.
3. Mandatory deliberation on presets that are not vote-reconcile.
4. Changing stream hard caps numbers without measurement (may align abort earlier as follow-up).

---

## Key Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Single finalize gateway** helper used by all runners | Prevents holdout drift |
| D2 | **formatExpect json** on all JSON-shaped roles with same 16k think-only class limits | eee6718f class on auditor path |
| D3 | **Structured vote ballot** when `councilReconcile: "vote"` | Optional freeform is insufficient |
| D4 | **DENY filter emissions** always system-visible | Operator trust |
| D5 | **Windows rewrites are best-effort allowlist**, not full shell | Safety + maintainability |

---

## Proposed Design

### 1. Finalize gateway

```typescript
// shared or server helper already partially exists
export function appendFinalizedAgentText(opts: {
  raw: string;
  role: string;
  agentId: string;
  onAnomaly: (a) => void;
}): { finalText: string; thoughts?: string }
// always: finalizeAgentOutput → streamIntegritySummaryFromAnomalies
```

Migration checklist (must be code-complete, not aspirational):

- [ ] `councilSynthesis.ts`
- [ ] `moaRunOne.ts` / MoA paths
- [ ] `MapReduceRunner.ts`
- [ ] `DebateJudgeRunner.ts`
- [ ] `OrchestratorWorkerRunner.ts` / Deep
- [ ] `roundRobinSynthesis.ts`
- [ ] `StigmergyRunner.ts`
- [ ] Any remaining `stripAgentText` alone on agent emit

Tests: each runner source-shape test or unit that finalize is imported/called.

### 2. JSON formatExpect expansion

Roles:

| Role | formatExpect | Notes |
|------|--------------|-------|
| Worker hunks | json (shipped) | — |
| Auditor verdict | json | |
| Replanner todos | json | |
| Standup merge / extract todos | json | |
| Contract criteria | json | |
| Lead plan OW | json | if applicable |

Wire through `thinkStreamGuardRuntime` / provider options consistently. Shared tests for pure-think abort.

### 3. Deliberation structure (vote mode)

When reconcile is vote:

```typescript
// required ballot fragment (schema)
{
  "disposition": "approve" | "deny" | "abstain",
  "rationale": string,
  "blocksPatterns"?: string[]  // optional DENY patterns
}
```

Parser accepts JSON ballot in addition to markdown fences. Missing ballot → vote ignored with system note (not silent).

On DENY filter drop:

```text
[deliberation] dropped todo "..." — matches DENY pattern "..."
```

Worker repair / worker prompt optional block:

```text
DELIBERATION DENY PATTERNS (do not re-propose):
- ...
```

### 4. Windows ToolDispatcher

Expand rewrite / hard-fail hints:

| Pattern | Action |
|---------|--------|
| `cmd1 && cmd2` simple two-step | Sequential in-process if both allowlisted |
| `type` / `dir` | Map to read/list |
| `findstr` | Map to grep-ish |
| Unix-only verifyCommand on win32 | System reason “skipped/rewritten” not silent worker fail |

Keep deny for dangerous full shell. Document “Windows host tool profile” in setup when `process.platform === 'win32'`.

### 5. Debug stream volume (follow-up)

Cap debug log stream snapshots similarly to WS (sample on anomaly only). Separate PR if large.

### 6. Align abort vs finalize caps (optional)

Document relationship:

- In-stream hard max total chars (guard)
- Post-finalize hard max (48k/24k)

Prefer abort **before** multi-minute waste when final would only be truncated—tune carefully with live metrics.

---

## Alternatives considered

| Alternative | Why rejected |
|-------------|--------------|
| Leave synthesis unfinalized “because shorter” | 9f449937 class was multi-minute loops; synthesis can still balloon |
| Force deliberation on all presets | Noise on non-vote modes |
| Full bash-to-PowerShell | High cost, low safety |

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Finalize changes synthesis tests | Update golden strings; keep strip semantics inside finalize |
| Structured votes break soft models | Fallback parse freeform once; then require structure |
| Windows rewrite wrong command | Allowlist only; fail closed with hint otherwise |

---

## Success metrics

1. `rg stripAgentText` on agent emit paths only appears inside finalize or non-agent utilities.
2. Auditor pure-think streams abort via formatExpect (unit).
3. Vote mode without ballot does not silently count as peer consensus.
4. DENY drop always leaves a system line (test).
5. Common `dir && type` style agent bash on Windows succeeds or fails with rewrite hint once (not thrash).

---

## PR Plan

### PR 1: Finalize gateway + migrate all runners

- **Files/components affected:** finalize helper, all holdout runners, stream integrity tests
- **Dependencies:** None  
- **Description:** Single append path; source-shape tests per runner; update strip-only tests.

### PR 2: formatExpect json for auditor/replanner/standup/contract

- **Files/components affected:** prompt agent call sites, thinkStreamGuardRuntime wiring, jsonFormatSniff tests
- **Dependencies:** None  
- **Description:** Wire sniff; pure-think abort tests per role.

### PR 3: Structured vote ballots + DENY visibility + repair seed

- **Files/components affected:** `deliberationProtocol.ts`, `councilSynthesis.ts`, `deliberationSeed.ts`, worker prompts, UI optional
- **Dependencies:** None  
- **Description:** Schema + parser; system lines on drop; DENY block in worker prompt when patterns present.

### PR 4: Windows rewrite expansion + verifyCommand messaging

- **Files/components affected:** `ToolDispatcher.ts`, tests, AGENT-GUIDE / setup copy
- **Dependencies:** None  
- **Description:** Expand allowlisted rewrites; win32 verifyCommand handling; no thrash loops on common patterns.

### PR 5 (optional): Debug stream sampling + cap alignment

- **Files/components affected:** `eventLogger.ts`, stream guard constants, docs
- **Dependencies:** PR 1  
- **Description:** Anomaly-only debug samples; document cap hierarchy.

---

## Acceptance checklist

- [ ] No agent emit holdouts without finalize  
- [ ] JSON roles use formatExpect sniff  
- [ ] Vote mode structured ballot  
- [ ] DENY drops visible  
- [ ] Windows common rewrites covered by tests  
- [ ] streamIntegrity counts synthesis anomalies when forced in test  

---

## Related

- `docs/postmortems/stream-guards-removed.md`  
- `shared/src/finalizeAgentOutput.ts`, `streamLoopDetect.ts`  
- Program RR-0 sequencing  
