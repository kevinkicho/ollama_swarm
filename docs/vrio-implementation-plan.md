# VRIO-Driven Implementation Plan

> Generated: 2026-05-08
> Based on: VRIO strategic analysis of ollama_swarm
> Status: Draft for Kevin's review

This plan prioritizes work that **reinforces sustained competitive advantages** and **addresses strategic risks**, rather than just filling gaps. P0–P3 (gap remediation) are mostly done; R1–R6 (refactoring) remain. This plan layers VRIO-driven items on top.

---

## Guiding Principles

1. **Reinforce what's unique.** Blackboard+CAS, open-weights multi-model, and observability depth are our moats. Every sprint should make at least one of these harder to replicate.
2. **Reduce bus-factor risk.** BlackboardRunner is 864 LOC. The one-file god-class risk can lose the sustained advantage overnight.
3. **Ship production readiness.** No auth, no static build, no deployment story means we can only reach localhost hackers. Open the funnel.
4. **Don't expand multi-provider features for their own sake.** The strategic note is clear: open-weights first. Paid-provider paths get bug fixes, not new features.

---

## Phase 1 — Moat Reinforcement (2–3 sprints)

Reinforces: **Blackboard+CAS**, **Open-weights multi-model**, **Observability**

### 1A. BlackboardRunner decomposition (reduces strategic risk #1)

> **Why:** 864 LOC god-class is our most important file and our biggest risk. If Kevin can't work on it for a month, nobody can. Decomposition doesn't add features — it preserves the sustained advantage.

- Extract `TierContext` type into `BlackboardRunnerTypes.ts` (currently inline)
- Extract `CapContext` type into `BlackboardRunnerTypes.ts`
- Extract `LifecycleContext` type (already exists in `lifecycleRunner.ts` — verify it's complete)
- Convert 2–3 context builders from `any` to proper interfaces per sprint
- Target: `BlackboardRunnerFields = any` comment removed by end of Phase 1

**Scope:** ~5 files, incremental
**Acceptance:** Each sprint converts 2–3 contexts. `tsc` passes. All 2485+ tests pass.

### 1B. Planner file-reading tools (reduces strategic risk #4)

> **Why:** The planner currently operates on seed context + file paths only, without reading files. This caps contract quality and is the #1 most-asked-for improvement. Every competitor that lets agents read files has a quality floor we can't reach yet.

- Add `read`, `grep`, `glob` to the planner's `ToolDispatcher` (workers already have these)
- Wire through `PlannerSeed` → planner prompt → tool calls
- Add `expectedSymbols` enhancement: planner uses grep to validate proposed symbols before including them in todos
- Validate: run council preset with and without planner tools; contract quality should improve measurably

**Scope:** `plannerRunner.ts`, `ToolDispatcher.ts`, `planner.ts` prompt, 1 test file
**Acceptance:** Planner can read/grep/glob files during seed phase. Skip rate stays below 15% or improves.

### 1C. Sibling-retry for workers (reinforces Blackboard+CAS moat)

> **Why:** Planner, contract, and auditor already have sibling-retry. Workers don't — when a worker's JSON parse fails after lenient extraction + repair, the todo goes stale and triggers replan. Sibling-retry would recover ~30-40% of those failures, improving throughput and reducing replan cycles.

- Add `WorkerPipeline` hook for sibling-retry on parse failure
- Reuse `siblingModelFor()` and `model_shift` event pattern from planner/contract/auditor
- Emit `model_shift` before retry, revert in `finally` block (same pattern as planner block)

**Scope:** `workerRunner.ts`, `WorkerPipeline.ts`, `BlackboardRunnerConstants.ts`
**Acceptance:** Worker parse failures that previously went stale now get one retry with a sibling model before staling.

---

## Phase 2 — Production Readiness (2 sprints)

Addresses: **Strategic risk #2 (no deployment story)**, **risk #3 (no auth)**

### 2A. Static build + deployment script

> **Why:** The app only runs on `npm run dev` (Vite dev server + backend). No production path exists. This limits us to technically capable users running local dev servers.

- Add `npm run build` to `web/` that outputs static assets to `web/dist/`
- Add `server/src/static.ts` middleware to serve `web/dist/` in production mode
- Add `NODE_ENV=production` start script that serves static + API from one port
- Add `Dockerfile` for containerized deployment
- Add `docker-compose.yml` with GPU passthrough for Ollama

**Scope:** ~4 new files, ~3 modified
**Acceptance:** `npm run build && npm start` serves the full app on one port. Docker container starts with `docker compose up`.

### 2B. WS authentication (P3-2 from gap plan)

> **Why:** No auth means the app is localhost-only. Any deployment beyond a single user requires authentication. This is the single highest-impact gate to broader adoption.

- Accept `?token=` query param on WS upgrade (same value as `OPENCODE_SERVER_PASSWORD`)
- Validate token before allowing connection (reject with 4001 if invalid)
- Update web client to pass `token` in WS connection URL
- Keep `runId` filter working alongside `token`
- Add `SWARM_AUTH_TOKEN` env var (default: `OPENCODE_SERVER_PASSWORD` for backward compat)

**Scope:** `server/src/ws/broadcast.ts`, `server/src/index.ts`, `web/src/hooks/useSwarmSocket.ts`
**Acceptance:** Unauthenticated WS connections rejected with 4001. Authenticated connections work. Multi-tenant filtering still works.

### 2C. Remaining P3 items (quick wins)

- **P3-1: API versioning** — Add `/api/v1/` prefix with backward-compatible redirect from `/api/swarm/*`
- **P3-3: CORS configuration** — Add `cors` middleware with `localhost` origins
- **P3-6: HTTP compression** — Add `compression()` middleware ✓ P3-4 (security headers) and P3-5 (request logging) already shipped this session

**Scope:** ~6 files, ~120 LOC total
**Acceptance:** All P3 items closed. `/api/v1/` works. CORS allows localhost. Compression active.

---

## Phase 3 — Refactoring for Velocity (ongoing, 1–2 items per sprint)

Reinforces: **Engineering Organization** capability (currently "Competitive Parity" — needs to reach "Strong")

### 3A. R1: BlackboardRunnerFields typing (started in Phase 1A, continues)

- Continue converting 2–3 context builders per sprint
- Target: all 126 property accesses typed by end of Phase 3

### 3B. R4: Deduplicate emitOutcome (quick win)

- Extract `OutcomeScoredEvent`, `DiscussionRunnerConfig`, `EmitOutcomeFn` into `runnerSharedTypes.ts`
- Replace 8 `emitOutcome: (outcome: any) => void` patterns
- 1 sprint

### 3C. R5: Merge wsProtocol types (quick win)

- Replace hand-maintained `SwarmEvent`/`AgentState` in `server/src/types.ts` and `web/src/types.ts` with `z.infer` re-exports from `shared/src/wsProtocol.ts`
- 1 sprint

### 3D. R2: Error response standardization (quick win)

- Create `server/src/middleware/apiResponse.ts` with `ApiError`/`ApiSuccess` types
- Migrate routes one at a time (don't break backward compat — keep `error` field as string)
- 1 sprint

> **Note:** R3 (web test infrastructure) is partially done — `applyEvent.test.ts` runs in Node via tsx without jsdom. Full component testing (BoardView, SetupForm, etc.) can be deferred until Phase 4 when production deployment creates user-facing regression risk.
> 
> **Note:** R6 (unify empty catch handling) is done in P1-1 (42 catch blocks logged). Remaining silent catches should get `// intentional: <reason>` comments during regular code review, not as a separate sprint.

---

## Phase 4 — Eval-Driven Preset Improvement (ongoing)

Reinforces: **10-Preset Breadth** (currently "Temporary Advantage") → convert to "Sustained Advantage" with empirical data

### 4A. Expand eval catalog

- Add 5–10 new eval tasks covering real-world scenarios (refactoring, debugging, documentation, multi-file changes)
- Add quality rubrics for new tasks
- Run full eval matrix (10 presets × 15–20 tasks) with latest models
- Publish RESULTS.md to repo

### 4B. Planner file-reading eval (validates 1B)

- Add eval tasks that specifically require planner file reading (e.g., "find the function that handles X and add Y")
- Compare contract quality with and without planner tools
- Expected: skip rate drops, contract relevance scores increase

### 4C. Model compatibility matrix

- Test top 10 open-weights models across all 10 presets
- Document which models work for which presets (some models struggle with structured JSON, tool calls, or long contexts)
- Publish compatibility matrix in docs

---

## Phase 5 — Observability Deepening (1 sprint)

Reinforces: **Observability Depth** (currently "Sustained Advantage" — keep compounding)

### 5A. Run comparison dashboard

- Add `/api/v2/runs/:runId/compare` endpoint that computes diff between two runs (different presets, same task)
- Web UI: side-by-side transcript comparison with diff highlighting
- Conformance delta charts

### 5B. Streaming token cost tracking

- Per-agent token counts are tracked server-side; surface them in real-time UI
- Add cost estimation based on model pricing data (hardcoded catalog, updated quarterly)
- Cumulative cost gauge in topbar

### 5C. Historical trend analysis

- Store per-run quality scores in `memoryStore`
- Add `/api/v2/stats/preset-performance` endpoint returning rolling averages per preset
- Web UI: preset performance heatmap over time

---

## Execution Priority Matrix

| Phase | Item | Reinforces | Risk Addressed | Sprint |
|-------|------|-----------|----------------|--------|
| 1A | BlackboardRunner decomposition | Blackboard+CAS | Bus factor | 1–3 |
| 1B | Planner file-reading tools | Blackboard+CAS | Quality cap | 1–2 |
| 1C | Worker sibling-retry | Blackboard+CAS | Reliability | 1 |
| 2A | Static build + deployment | Production usage | No deployment | 4 |
| 2B | WS authentication | Production usage | No auth | 4–5 |
| 2C | P3-1/3/6 remaining | Ops hardening | — | 5 |
| 3A | R1 continue typing | Organization | Bus factor | 4–8 |
| 3B | R4 emitOutcome dedup | Organization | — | 5 |
| 3C | R5 wsProtocol merge | Organization | — | 6 |
| 3D | R2 error response standard | Organization | — | 6 |
| 4A | Expand eval catalog | 10-Preset breadth | Erosion | 6–7 |
| 4B | Planner tools eval | Blackboard+CAS | Validation | 7 |
| 4C | Model compatibility matrix | Open-weights | User confusion | 7 |
| 5A | Run comparison dashboard | Observability | — | 8 |
| 5B | Streaming cost tracking | Observability | — | 8 |
| 5C | Historical trend analysis | Observability | — | 9 |

---

## What We're NOT Doing (and Why)

| Not doing | Why |
|-----------|-----|
| Expanding Anthropic/OpenAI-specific features | Strategic note: open-weights first. Bug fixes yes, new features no |
| Adding new presets | 10 presets already; need depth (eval, quality) not breadth |
| Full web component test suite (R3) | `applyEvent.test.ts` covers the critical path; component tests can wait until production deployment creates regression risk |
| R6 (catch handling audit) | P1-1 logged 42 blocks; remaining ones get `// intentional:` comments during regular review |
| Mobile app / native client | Not the target user; localhost-first remains the deployment model |
| Auth beyond WS token | P3-2 (WS token auth) is sufficient for single-team deployment; OAuth/RBAC is out of scope |
| Database / persistence layer | `RunStatePersister` + JSONL event log is the right abstraction for this scale; don't over-engineer |