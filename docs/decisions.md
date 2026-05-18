# Architecture Decisions

Short, dated docs explaining non-obvious "why this and not that" choices.

---

## 001 — Per-agent isolation (subprocess → in-process)

**Status:** Superseded by E3 Phases 1–5 (2026-04-29)

Originally: each agent got its own opencode subprocess on a dedicated port (N agents = N processes). Rationale: complete failure isolation — a stuck SSE on one agent doesn't affect others.

**What changed:** All subprocesses removed in E3 Phase 5. Every prompt now goes through `pickProvider` → `chatOnce`. Tool-using turns use an in-process `ToolDispatcher`. The isolation model is now per-agent session-state objects rather than OS-level processes. RAM cost dropped from ~50MB per agent to zero.

---

## 002 — Search/replace hunks

**Status:** Accepted, stable

Workers return Aider-style search/replace hunks:
```ts
{ op: "replace", file: "...", search: "<anchor>", replace: "<new>" }
{ op: "create",  file: "...", content: "<full content>" }
{ op: "append",  file: "...", content: "<text>" }
```

**Why:** Far smaller payloads than full-file replacement, more reliable JSON output than unified diffs. Models produce these reliably — no line-number arithmetic, no malformed diff headers. Conflict detection is automatic (if another worker changed the anchor between read and write, apply fails closed).

**Revisit if:** we need bulk rename/delete operations, or a model ships that's reliably better at unified diffs.

**Code:** `applyHunks.ts`, `worker.ts`, `applyHunks.test.ts`.

---

## 003 — Write-capable presets (blackboard native, discussion opt-in)

**Status:** Superseded by `cfg.writeMode` rollout (2026-05-04)

Originally: only `blackboard` could modify files. Rationale: single write pipeline with proven coordination story (CAS hashes, hunk apply, commit).

**What changed:** `cfg.writeMode: "single"` added to all 9 discussion presets. Each preset's synthesizer (council president, MoA aggregator, map-reduce reducer, debate judge, etc.) produces hunks after discussion. `writeMode: "multi"` (multi-writer per preset) is deferred. `stigmergy` remains read-only by design.

**Code:** `synthesizerHunks.ts`, `wrapUpApplyPhase.ts`, per-runner write phase in `{Council,Moa,MapReduce,...}Runner.ts`.

---

## 004 — V2 parallel-track rollout

**Status:** Accepted, active

Every V2 substrate ships behind a flag alongside V1. Validated for divergence before V1 is deleted. Components: `RunStateObserver`, `TodoQueueV2`, `WorkerPipelineV2` (gated by `USE_WORKER_PIPELINE_V2`), `OllamaClient` (gated by `USE_OLLAMA_DIRECT`), `EventLogReaderV2`.

**Why:** Big-bang cutover would mean weeks of "this branch is broken, don't merge." Parallel-track means each substrate ships to main immediately, default-off, validated by toggling flags. A regression means flipping a flag back — no code change needed.

**Revisit when:** last substrate is default-on for 2+ stable runs with 0 divergences.

---

## 005 — Keep opencode subprocess (SUPERSEDED)

**Status:** Superseded 2026-04-29 by E3 Phases 1–5

Originally decided to keep opencode for non-blackboard runners and only drop it for blackboard after V2 stabilized. The V2 path proved stable earlier than expected, and the subprocess was removed from ALL runners in one effort. The opencode SDK is uninstalled; `AgentManager.spawnAgent` no longer spawns subprocesses.

---

## 006 — Implementation roadmap (proposed)

Large roadmap attached — see `docs/decisions/006-implementation-roadmap.md` for the full 806-line plan covering: Self-Improving Orchestration, Autonomous Productivity, Swarm Intelligence, Development Velocity, Evaluation & Benchmarking, Platform Maturation, and Integration & Extensibility. Not yet broken into actionable phases.
