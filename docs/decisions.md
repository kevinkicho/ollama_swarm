# Key Decisions

This document records major architectural and product decisions with their rationale and status.

## 2026-07-09: Live prompt paths use transport retries and think-stream caps only

**Decision:** Agent prompt paths use **transport retries** (network/timeouts) and the
narrow **think-stream** hard caps in `shared/src/streamThinkGuard.ts`. The older
stack (pre-tool character caps, intra-stream loop modules, stream-abort retry
addenda, transport retry on guard abort, turn-level `SWARM_LOOP_DETECTION`) is
**removed** from live paths.

**Removed modules / behaviors (historical):**
- `STREAM_GUARD_*` **pre-tool** character caps and `intraStreamLoop` modules
- `streamAbortRetry` addenda prepended on guard abort
- Retryability of `intra-stream loop` / `runaway stream` errors in `retry.ts`
- Turn-level `SWARM_LOOP_DETECTION` / `maybeEmitLoopWarning`
- `semanticLoopDetector.ts` and `intraStreamLoopDetector.ts` modules

**Retained think-stream path:** `streamThinkGuard` — think-**only** hard caps
(160k chars / 120s / repetitive tail) via `composePromptGuardSignals`.
`isPromptGuardAbort` keeps those aborts out of transport-retry replay (emit-only
salvage; full explore prompt replay is out of scope).

**Extension in progress:** Think-stream **referee checkpoint** (soft tier + agent
triage). Design: `docs/design/think-guard-referee-checkpoint.md`. Flag
`THINK_GUARD_REFEREE_ENABLED` defaults **off**; user/Brain can tune budgets mid-run.

**Rationale:** Old guards aborted after large spend then restarted the full explore
prompt — 2×–4× billed work. Referee extension keeps anti-retry + emit-only salvage.

**Detail:** `docs/postmortems/stream-guards-removed.md`

**Status:** Old stack removed. Narrow `streamThinkGuard` retained. Referee extension
landed incrementally (PR 0–1 + budget UI); defaults off.

---

## 2026-07-10: Primary loop gates are empty-output, plan-empty, caps, and board progress

**Context:** Around 2026-07-07/08, long agent outputs that *looked* like
repetition were diagnosed as dead loops. Later observation: many of those
runs were agents **reading large prior-run logs / stockpiled worker output**
that legitimately shared vocabulary while building on previous work —
productive work with overlapping prose, rather than byte-identical self-loops.

**Decision:** **Primary whole-run automated stops** are:
- **OutputEmpty dead-loop** — new agent turns are empty / `looksLikeJunk` only
  (safe when agents re-read log stockpiles with similar prose)
- **PlanEmpty dead-loop** — zero parseable assignments (OW family)
- **Token budget / wall-clock / quota** — resource caps
- **Blackboard tier stuck / council audit stuck** — board/ledger progress
- **Transport retries** — network failures

**Optional similarity signals:** Jaccard / embedding similarity remain valid as
**optional stop-early / “discussion settled”** helpers (e.g. MoA/RR convergence)
when the product intent is saving rounds after agreement. They are **secondary**
to the primary gates above; log re-reads and multi-round refinement produce high
overlap without meaning the run is stuck.

**Situations that produce high text overlap while work continues:**
- Re-reading prior workers’ logs with shared vocabulary
- Legitimate multi-round refinement with overlapping claims
- Large shared context (seed + transcript) dominating token sets

**Status:** Aligns with 2026-07-09 stream-guard removal. Primary gates =
empty-output + caps + progress signatures.

---

## 2026-07-08: Parallel `:cloud` fan-out is open (no in-app admission queue)

**Decision:** All agents in a fan-out (council contract draft, blackboard workers,
etc.) **may open provider streams concurrently**. Live paths use open parallel
`:cloud` prompts — no local admission semaphore, slot queue, or artificial cap
on concurrent `:cloud` callers.

**Historical removal (shipped):**
- `cloudAdmission.ts` — `acquireCloudSlot` / `releaseCloudSlot` (max 2 concurrent)
- `burstSpacingForModels` widening to 3s per agent for `:cloud` bursts
- UI copy that implied “cloud slot”, “throttled, waiting to send”, or “request sent
  but no bytes” while the app itself held the prompt

**Rationale:**
- The stack supports multiple concurrent streams to the AI provider; the admission
  layer added misleading dock/sidebar states when agents were healthy but locally queued.
- Council and similar presets are designed for parallel independent drafts; serializing
  one agent while others showed “waiting for model” was worse UX than provider-side
  queue latency.
- Cold-start and provider queue behavior are real; surface them honestly (elapsed time,
  streaming when bytes arrive) rather than simulating pipeline stages.

**When provider overload is real:** fix at the provider/gateway layer (retries, backoff,
failover chain in `providerFailover`) or reduce `agentCount` / preset parallelism.
Keep `promptWithRetry` unblocked by an in-process admission pipe.

**Status:** Shipped. Reintroducing in-app cloud admission is a product regression
unless this decision is explicitly reversed here.

---

## 2026-07-08: Council stop waits for execution workers before close-out

**Decision:** Hard `stop()` **writes the run summary and calls `killAll()` only after**
`runCouncilWorkers` has settled (or the bounded wait expires). Close-out waits on
`workerDrainPromise` (bounded timeout), aborts in-flight provider HTTP via
`Session.abortController`, and freezes the transcript after `writeSummary()` so
stragglers leave the log alone.

**Ideal behavior (full sequence):** See `docs/run-stop-drain-lifecycle.md`.

**Fixes that are load-bearing:**
- `awaitLoopThenCloseOut` raced the main loop on a **15s timeout** while execution
  workers were still running — “ports released” while literature/worker/hunk lines
  still landed (run `43e79fa7`).
- Hard `stop()` setting `drainRequested = true` (`drainRequested` belongs on soft `drain()`).
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
