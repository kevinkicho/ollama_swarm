# Postmortem — run `2964afe8` (council, 78.6m)

| Field | Value |
|-------|-------|
| **Run id** | `2964afe8-ea3c-4398-91c3-fc28c768b920` |
| **Preset** | council · 3 drafters · `deepseek-v4-flash:cloud` |
| **Wall** | 78.6 min · user stop |
| **Files changed** | 22 |
| **applyIntegrity** | attempts 24 / applied 22 · miss: 1 search_not_found, 1 start_not_unique · repairSuccess 1 |
| **cycleIntegrity / researchIntegrity** | absent on summary (telemetry cleared post-snapshot or never non-empty at write) |
| **Code tip at run** | At/near `f52f638` (emit-only + `ollamaFormat:json` already on council workers) |

This analysis is **evidence → code path → mechanism**. It deliberately does **not** propose drive-by patches.

---

## What the user saw (restated correctly)

| Cycle | Reported complete | What it means |
|-------|-------------------|---------------|
| 1 | 1 done, 0 failed | Healthy small batch |
| 2 | 6 done, 2 failed | Mostly healthy |
| 3 | 2 done, 4 failed | Rising thrash |
| **4** | **3 done, 28 failed** | **Not 28 unique todos** — see accounting below |
| 5 | 0 done, 2 failed | One audit test mega-todo, 2 attempts |
| 6 | 9 done, 2 failed | Recovery burst |
| **7** | **0 done, 8 failed** | **4 todos × 2 settlement attempts** |
| **8** | **0 done, 8 failed** | Same |

Permanent-skip lines:

- Cycle 4: **14** todos permanent-skipped (`t13`, `t17`…`t29`)
- Cycles 7–8: **4 + 4** permanent-skipped

So cycle 4 “28 failed” ≈ **14 todos × ~2 settlement attempts** (and other fail events), not 28 distinct work items.

---

## Timeline (ambition + flood)

1. **Tier 1–3** install criteria; workers land real routes/panels/docs (applyIntegrity applied=22 is real progress).
2. **Tier 4** installs more API/route criteria (IEA/WHO/UNEP/FAO style).
3. **Cycle 4 standup** synthesizes **17 proposals** after merge/order:
   - Transcript: `[execution-plan] Ordered 17 todo(s) — impl:2, docs:2, build:13 (build last).`
4. Of those 13 “build” todos, agents immediately do:
   - `[execution] agent-N running build command: \`vitest\` (binary: vitest)`
5. **No file creates** for `__tests__/*` before running Vitest → build path fails closed (no git changes / non-zero / empty success criteria).
6. Settlement requeues unresolved once (`max 2 attempts/todo`), then **permanent-skips 14**.
7. **Audit** keeps minting more “Create Vitest unit tests…” todos (cycles 5, 7, 8) → **zero durable progress** streak while board stays noisy.

---

## Root cause 1 (PRIMARY) — Create-test todos misclassified as `kind: "build"` + `command: "vitest"`

### Evidence from transcript

Cycle 4 plan line:

```text
[execution-plan] Ordered 17 todo(s) — impl:2, docs:2, build:13 (build last).
```

Then for almost every test-shaped description:

```text
[execution] agent-2 working on: Create server/__tests__/fao.test.js — Vitest test for FAO route...
[execution] agent-2 running build command: `vitest` (binary: vitest)
```

Cycles 7–8: **every** claim is either “Create Vitest unit tests…” or multi-file `__tests__/*.test.js` creation, immediately followed by **`running build command: vitest`**. Zero `✓ applied`. Zero `primary failed` (because the **hunk path is never entered**).

### Code path

`buildCouncilTodoPost` → `classifyCouncilTodo` (`server/src/swarm/councilTodoClassify.ts`):

```134:141:server/src/swarm/councilTodoClassify.ts
  for (const runner of ["jest", "vitest", "mocha", "eslint", "prettier", "tsc"]) {
    if (new RegExp(`\\b${runner}\\b`).test(lower) && !editIntent) {
      const cmd = runner;
      if (checkBuildCommand(cmd).ok) {
        return { kind: "build", command: cmd, expectedFiles };
      }
    }
  }
```

`editIntent` is only:

```text
fix|add|update|rewrite|replace|implement|refactor|remove|delete|indent|clean up|patch
```

**`create` is not included.**  
Description: *“Create Vitest unit tests for fao…”* → contains `vitest` → **no** editIntent → **`{ kind: "build", command: "vitest" }`**.

Same for bare `pytest` / `jest` loops.

### Why that guarantees 0% success

`executeCouncilBuildTodo` (`councilWorkerRunner.ts`):

1. Prompts the model to run **exactly** `todo.command` via bash.
2. Explicitly: *“Do not edit files manually — bash side effects are the entire delivery mechanism.”*
3. Success = **git tree has changes after the command**.

Running bare `vitest` when tests **do not exist yet** (or exist but fail):

- produces **no new files**, or
- exits non-zero without a coherent commit,

→ todo fails → requeue → permanent skip.

**This is not a model-intelligence problem.** The control plane **forbade** the only valid delivery mechanism (hunk create of `__tests__/*.test.js`) and forced a **run-tests-only** worker.

### Secondary classifier issues (same family)

| Description shape | Classifier outcome | Correct path |
|-------------------|--------------------|--------------|
| Create Vitest tests for routes X… | `build` / `vitest` | `hunks` (create files) |
| Create server/\_\_tests\_\_/fao.test.js — Vitest test… | `build` / `vitest` | `hunks` |
| Run vitest / Execute `vitest` after tests exist | `build` / `vitest` | `build` (legitimate) |
| Add error handling to server.ts | `hunks` | correct |

`councilExecutionTier` then labels these as tier **`build`** (last), so the plan summary *looks* intentional (“build last”) while the semantics are wrong.

---

## Root cause 2 (SECONDARY) — Worker JSON / think thrash (cycles 2–6, not 7–8)

### Evidence

Primary fail reasons (whole run):

```text
6× JSON parse failed: Unexpected token '<', "<think>We "... is not valid JSON
4× worker returned no hunks
1× json format sniff: 8,193 chars streamed without JSON markers
```

Exhaustion:

```text
all retries exhausted (...); no failover model in chain
```

### Mechanism

Even with council emit-only + `ollamaFormat: "json"` (preflight `bc20667`):

1. **DeepSeek cloud still prefixes raw `<think>`** (or emits think-only).  
   `parseJsonEnvelope` / strip path still fails when there is **no** JSON envelope after strip, or residual `<` confuses parse.
2. Stage-2 **JSON/envelope repair** is the right class for these, but often also fails (same model, same format).
3. Stage-3 **failover** never runs: `providerFailover` empty → *“no failover model in chain”*.
4. **applyIntegrity** only saw **2** structured apply misses total — so **most cycle-4 damage was not apply-anchor miss**; it was **never reaching a successful hunk parse/commit**, or **build-path failures** that don’t go through `applyHunks`.

### Why cycle 4 still shows only 2 “primary failed” lines but 28 “failed”

- Many todos never print `primary failed` because they go **straight to build** (`running build command: vitest`).
- Settlement bookkeeping counts **failed agent outcomes / requeue passes**, not unique work items.
- 14 permanent-skips × 2 attempts ≈ 28 fail counters (plus a few hunk-path JSON fails earlier in the cycle).

---

## Root cause 3 (ORCHESTRATION AMPLIFIER) — Ambition ratchet + audit re-injection

1. **Tier promotion** repeatedly expands criteria (tier 1→4). Each tier adds “met” pressure and new work.
2. Cycle 4 standup: **17** todos in one plan after overlap merge — oversized vs 3 agents.
3. After permanent-skip of tests, **audit LLM** still invents new “Create Vitest…” / multi-file test todos (cycles 5, 7, 8).
4. Progress gate logs `Zero durable progress streak N/3` but **audit still enqueues** more identical work → dead thrash until user Stop.

This is not the *first* cause of failure; it is why failure **repeats for ~80 minutes** after the classifier bug is already fatal for the test queue.

---

## Root cause 4 (METRICS / OBSERVABILITY GAP)

| Signal | On this run | Consequence |
|--------|-------------|-------------|
| `applyIntegrity` | Present (looks “healthy”: 22/24) | Understates catastrophe — **build-path failures don’t count as apply miss** |
| `cycleIntegrity` | **Missing** | No failByBucket digests offline |
| `researchIntegrity` | **Missing** | N/A for this thrash mode |
| Complete line “28 failed” | Attempt-level | Operators misread as 28 unique broken todos |

So a glance at applyIntegrity alone would **miss the primary root cause**.

---

## Cycle 7–8 specifically (0 done / 8 fails)

| Observation | Interpretation |
|-------------|----------------|
| 4 pending todos drained | Audit batch of 4 |
| All claims → `running build command: vitest` | Classifier → build |
| 0 `primary failed` | Hunk path unused |
| 0 `✓ applied` | No commits |
| Re-queued 4, then Permanent-skipped 4 | maxAttempts=2 settlement |
| Complete 0 done, **8 failed** | 4 × 2 attempts |

**Same root cause as cycle 4’s build:13 block**, not a new bug unique to late cycles.

---

## What is *not* the root cause (ruled out)

| Hypothesis | Why rejected |
|------------|--------------|
| Apply anchor miss epidemic | Only 2 apply-miss events whole run |
| Literature / DDG thrash | Not dominant in cycle 4/7/8 lines |
| Soft-done infinite spin | User stop; soft-done policy already terminal |
| Empty-execution guard | Not the failure mode here |
| “Model is dumb” as primary | Control plane forced wrong worker modality |

---

## Correct long-term fix directions (design, not drive-by)

These are **structural**; order is dependency-aware.

### A. Classifier semantics (must fix first)

1. Treat **create/write/implement tests/files** as **hunks**, even if `vitest`/`jest`/`pytest` appears as a *framework name*.
2. Only promote to `kind:build` when intent is **run** the tool:
   - Explicit: `run vitest`, `execute \`vitest\``, `npm test`
   - Not: `Create Vitest unit tests for…`, `Add vitest coverage for…`
3. Add `create|write|scaffold|generate` to editIntent **or** require `run|execute` for runner-token build promotion.
4. Regression tests with **exact transcript strings** from this run.

### B. Build worker contract

1. Build todos must only run when **preconditions hold** (test files exist) — or fail with a **structured** reason that requeues as **hunks** create.
2. Never invent `command: vitest` from a create-tests description.

### C. Settlement / metrics honesty

1. Separate counters: `todosFailedUnique` vs `attemptFailures`.
2. Count build-path failures under `cycleIntegrity` (`schema` / dedicated `build_misroute` / `noop`).
3. Keep applyIntegrity for pure apply; don’t use it as overall health.

### D. Ambition + audit coupling

1. Cap todos enqueued per cycle (or per tier step).
2. After permanent-skip of a test create class, audit must **not** re-mint the same shape without progress signal.
3. Tie “create tests” criteria to **file existence** checks, not “vitest green” until files exist.

### E. JSON path residual (secondary)

1. Treat pure-`<think>` after format:json as **format/provider** failure with optional failover.
2. Ensure `providerFailover` is configured in live setups if multi-model recovery is expected.
3. Strengthen strip/salvage only as defense-in-depth — not a substitute for A/B.

---

## Summary for operators

| Question | Answer |
|----------|--------|
| Why cycle 4 “28 fails”? | ~14 misrouted test todos × 2 settlement attempts + some JSON thrash; 3 real hunk commits succeeded |
| Why cycles 7–8 0 done / 8 fails? | Audit re-enqueued 4 create-test todos; all classified as **run vitest**; 2 attempts each; 0 hunks |
| Deepest root cause? | **`classifyCouncilTodo` promotes “Vitest” in create-test prose to `kind:build`**, and **build worker cannot create files** |
| Why applyIntegrity looks fine? | Build failures never hit apply; the real failures are **routing**, not anchors |

---

## Artifact paths

- Summary: `server/logs/2964afe8-ea3c-4398-91c3-fc28c768b920/summary.json`
- Debug: `logs/2964afe8-ea3c-4398-91c3-fc28c768b920/debug.jsonl` (+ rotations)

---

*No code was changed for this postmortem; analysis only, per request to avoid quick fixes.*
