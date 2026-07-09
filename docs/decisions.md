# Key Decisions

This document records major architectural and product decisions with their rationale and status.

## 2026-07-09: No stream guards or loop-detection aborts on agent prompts

**Decision:** Do **not** use the **old** stream guard stack (100K pre-tool caps,
intra-stream loop modules, stream-abort retry addenda, transport retry on guard abort).

**What we removed (do not bring back without explicit reversal):**
- `STREAM_GUARD_*` **pre-tool** character caps and `intraStreamLoop` modules
- `streamAbortRetry` addenda prepended on guard abort
- Retryability of `intra-stream loop` / `runaway stream` errors in `retry.ts`
- Turn-level `SWARM_LOOP_DETECTION` / `maybeEmitLoopWarning`
- `semanticLoopDetector.ts` and `intraStreamLoopDetector.ts` modules

**Narrow exception retained:** `shared/src/streamThinkGuard.ts` — think-**only**
hard caps (160k chars / 120s / repetitive tail) via `composePromptGuardSignals`.
Transport retry on guard abort is **blocked** (`isPromptGuardAbort`). No full
explore prompt replay.

**Extension in progress:** Think-stream **referee checkpoint** (soft tier + agent
triage). Design: `docs/design/think-guard-referee-checkpoint.md`. Flag
`THINK_GUARD_REFEREE_ENABLED` default **off**; user/Brain can tune budgets mid-run.

**Rationale:** Old guards aborted after large spend then restarted the full explore
prompt — 2×–4× billed work. Referee extension preserves anti-retry + emit-only salvage.

**Detail:** `docs/postmortems/stream-guards-removed.md`

**Status:** Old stack removed. Narrow `streamThinkGuard` retained. Referee extension
landed incrementally (PR 0–1 + budget UI); not default-on.

---

## 2026-07-08: No client-side `:cloud` admission / concurrency throttling

**Decision:** Do **not** implement local “cloud admission”, slot queues, or artificial
limits on how many agents may call `:cloud` models in parallel. All agents in a
fan-out (council contract draft, blackboard workers, etc.) may open provider
streams concurrently without waiting on an in-app semaphore.

**What we removed (do not bring back):**
- `cloudAdmission.ts` — `acquireCloudSlot` / `releaseCloudSlot` (max 2 concurrent)
- `burstSpacingForModels` widening to 3s per agent for `:cloud` bursts
- UI copy that implied “cloud slot”, “throttled, not sent yet”, or “request sent
  but no bytes” when the app itself was blocking the prompt

**Rationale:**
- The stack already supports multiple concurrent streams to the AI provider; the
  admission layer added misleading dock/sidebar states and made the product feel
  broken when agents were healthy but locally queued.
- Council and similar presets are designed for parallel independent drafts; throttling
  one agent while showing “waiting for model” on others was worse UX than provider-side
  queue latency.
- Cold-start and provider queue behavior are real; they should be surfaced honestly
  (elapsed time, streaming when bytes arrive), not simulated with fake pipeline stages.

**If provider overload becomes a problem:** fix at the provider/gateway layer
(retries, backoff, failover chain in `providerFailover`) or reduce `agentCount` /
preset parallelism — **not** a hidden in-process pipe that blocks `promptWithRetry`.

**Status:** Shipped (removed). **Agents and contributors: treat reintroducing cloud
admission as a regression unless the product owner explicitly reverses this decision
in this file.**

---

## 2026-07-08: Council stop must wait for execution workers before close-out

**Decision:** Hard `stop()` must not write the run summary or call `killAll()` while
`runCouncilWorkers` is still in flight. Close-out waits on `workerDrainPromise` (with
a bounded timeout), aborts all in-flight provider HTTP via `Session.abortController`,
and freezes the transcript after `writeSummary()` so stragglers cannot append.

**Ideal behavior (full sequence):** See `docs/run-stop-drain-lifecycle.md`.

**What we fixed (do not regress):**
- `awaitLoopThenCloseOut` racing the main loop on a **15s timeout** without waiting for
  execution workers — caused “ports released” while literature/worker/hunk lines still
  landed (run `43e79fa7`).
- Hard `stop()` setting `drainRequested = true` (soft-drain flag only belongs on `drain()`).
- Literature pre-pass calling `chatOnce` without an abort signal.
- `killAll()` not aborting stored `Session.abortController` instances (E3 cloud path has
  no local subprocess to kill; HTTP must be cancelled explicitly).
- `appendSystem` / `appendCouncilAgent` accepting lines after summary write.

**Rationale:** Users read “Run stopped” and “ports released” as terminal. Post-stop
transcript noise looks like a bug and wastes tokens/commits on an abandoned run.

**Status:** Shipped. **Agents: if you see messages after “ports released”, compare
implementation to `docs/run-stop-drain-lifecycle.md` and restore the contract.**

---

## 2026-04-29: E3 — Complete removal of opencode subprocess

**Decision:** Retire the per-agent `opencode serve` HTTP subprocess and the associated SDK client entirely.

**Rationale:**
- Simplified the agent model to direct providers + in-process ToolDispatcher.
- Removed a major source of port allocation, process management, and reliability issues.
- Allowed uniform treatment of all 5 providers (Ollama, Cloud, OpenCode, Anthropic, OpenAI).

**Status:** Shipped. `OPENCODE_SERVER_PASSWORD` remains only for config validation backward compat.

## 2026-05: Hybrid planning + execution (later removed)

**Decision (later superseded):** Support `useHybridPlanning` with separate `planningPreset` and `executionPreset`, defaulting to council → blackboard.

**Update 2026-07:** Hybrid mode fully removed from the app. Use `pipeline` preset for similar chaining needs.

**Rationale:**
- Planning phase (debate/synthesis) builds rich context and deliverable.
- Execution phase (blackboard) provides robust, concurrent, auditable writes.
- Piping mechanism allows the strengths of discussion presets to feed the write-capable blackboard without losing the latter's coordination primitives.

**Status:** Shipped and hardened (see July 2026 fixes for autonomous exec phase lifetime).

## Auditor-only mutations (high-safety mode)

**Decision:** Add `auditorOnlyMutations` + `requireAuditorVerification` so workers only *propose* and the auditor is the sole mutator + committer.

**Rationale:**
- Reduces blast radius of worker mistakes.
- Enables a single, high-quality git commit for a batch of related changes.
- Aligns with "auditor as the only entity that touches the repo" safety model.

**Status:** Shipped.

## Self-upgrader is recording-only

**Decision:** Brain proposals are written to `logs/upgrades.jsonl` (or similar) but never auto-applied.

**Rationale:**
- Safety: platform changes must be manually reviewed.
- Auditability: every proposal is traceable to the run(s) that inspired it.

**Status:** Deliberate limitation (see known-limitations.md).

---

(Additional historical decisions are recorded in the git history and older plan documents in `docs/plans/archive/`.)
