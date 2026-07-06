# Key Decisions

This document records major architectural and product decisions with their rationale and status.

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
