# Session checkpoint

> Last updated: 2026-05-18
> Status: **finished**

## Task
Autoresearch Tier 0-1 — survey codebase, find and fix bugs

## Done

### Tier 0: Survey (COMPLETE)
- Read all 8 active docs, 3 package.json files, run-tests.mjs
- Listed all .ts files (server 100+, web 60+ .tsx, shared 20)
- Read key entry points: index.ts, swarm.ts route, config.ts, MessageBubble.tsx
- Ran git log -30 to see recent work patterns
- **Map:** 11 swarm presets, 5 providers, 2732 tests. All prompts through pickProvider→chatOnce. No subprocesses. Blackboard is the flagship preset.

### Tier 1: Bug fixes (IN PROGRESS)

#### MessageBubble missing deliverable bubble + unknown-kind handler (shipped: 26a1227)
- `deliverable` summary kind (preset, filename, fullPath, bytes, sectionTitles) had NO dispatch branch in SystemBubble — rendered as generic system text. Now shows emerald-bordered card.
- Both SystemBubble and AgentBubble now log `console.warn("Unhandled ... kind: \"X\"")` for unknown summary kinds, preventing silent rendering failures.
- Updated formatServerSummary exhaustiveness test to include 3 missing kinds (stigmergy_annotation, agents_ready, deliverable).

#### Next: AbortController cleanup for polling fetch calls (SHIPPED: 02af84f)
- 17 polling fetch calls lacked AbortControllers — only 2 had been fixed in prior session
- Fixed: ActiveRunsPanel (5s poll), UsageWidget (10s/30s poll), App.tsx review status (15s poll), App.tsx review hydration, SwarmStoreProvider REST hydration
- Each now: creates AbortController on mount, passes signal to fetch(), calls ctrl.abort() on cleanup
- One-shot form submissions (stop, drain, say, start, amend) remain unwrapped (fire-and-forget)

#### Tier 2: Expand test coverage (IN PROGRESS)
- Added 16 tests for `summarizeAgentJson.ts` (shipped: c58b29a)
- ~~Continue~~ → session ended

### Autoresearch auto-resume plugin (shipped: 1312a6b + d9e61c8)
- Created `.opencode/plugins/session-checkpoint.ts` — listens for `session.idle`, reads checkpoint status, auto-sends "autoresearch" prompt if `in_progress`, stops if `finished`
- Updated autoresearch SKILL.md with "FIRST ACTION: set checkpoint to in_progress" rule
- Updated opencode.json: `compaction.auto: true`, full permissions, `tail_turns: 10`, `reserved: 8000`

## Files edited
- `web/src/components/transcript/MessageBubble.tsx` — deliverable bubble + unknown-kind handlers
- `server/src/swarm/blackboard/formatServerSummary.test.ts` — 3 missing sample kinds
- `web/src/components/ActiveRunsPanel.tsx` — AbortController for poll
- `web/src/components/UsageWidget.tsx` — AbortController for poll
- `web/src/App.tsx` — AbortController for review status + hydration
- `web/src/state/SwarmStoreProvider.tsx` — AbortController for REST hydration
- `shared/src/summarizeAgentJson.test.ts` — 16 new tests
- `server/scripts/run-tests.mjs` — registered new test file
- `.opencode/plugins/session-checkpoint.ts` — auto-resume plugin (NEW)
- `.opencode/skills/autoresearch/SKILL.md` — in_progress rule (NEW)
- `.opencode/package.json` — plugin deps (NEW)
- `opencode.json` — compaction + permissions

## Files edited
- `web/src/components/transcript/MessageBubble.tsx` — added deliverable bubble + unknown-kind handlers in SystemBubble and AgentBubble
- `server/src/swarm/blackboard/formatServerSummary.test.ts` — added 3 missing sample kinds to exhaustiveness test
- `web/src/components/ActiveRunsPanel.tsx` — AbortController for 5s poll
- `web/src/components/UsageWidget.tsx` — AbortController for polling fetch
- `web/src/App.tsx` — AbortController for review status poll + hydration
- `web/src/state/SwarmStoreProvider.tsx` — AbortController for REST hydration
- `shared/src/summarizeAgentJson.test.ts` — 16 new tests
- `server/scripts/run-tests.mjs` — registered new test file

## Test counts
- Start: 2732
- Current: **2748** (+16 — 16 new summarizeAgentJson tests)
- All passing, zero failures

## Task
Model resolution pipeline consolidation + "New swarm" button fix + doc reorganization

## Done

### New swarm button fix
- When reviewing historic runs and clicking "New swarm", the browser now navigates to `/` instead of getting stuck showing "Waiting for agents..." in a review URL that can never reach the setup form.

### Model resolution consolidation
- **Created `shared/src/modelConfig.ts`** — single `resolveModels()` pure function. 31 scattered decision points → 1 function.
  - `resolveModels(input, defaults)` → `{ model, plannerModel, workerModel, auditorModel }`
  - Fallback chain: explicit field → topology override → role default → model → config default
  - Planner: no role default (model IS the default)
  - Worker/Auditor: role default before model fallback
- **Updated `swarm.ts` route** — replaced all `eff*Model` variables and scattered `??` chains with a single `resolveModels()` call at the top of the POST /start handler. All model fields passed to `orch.start()` now come from the resolved result.
- **Fixed `TopologyGrid.tsx`** — removed the localStorage topology overlay that forced stale `plannerModel` (glm-5.1:cloud) onto cached topologies. Models now come from current form state only; grid structure (roles/colors/tags) are all that localStorage preserves.
- **Added 8 regression tests** in `shared/src/modelConfig.test.ts` covering: model catch-all, explicit override, config defaults, non-blackboard sharing, topology vs explicit precedence, auditor default on blackboard.

### Documentation reorganization
- **Consolidated from 27 docs to 20** (active docs: 8, archives: 12)
- **New `docs/changelog.md`** — all notable changes reverse-chronological, plus maintenance log. Replaces `docs/MAINTENANCE-LOG.md`.
- **New `docs/decisions.md`** — all 6 ADRs in one file. Replaces `docs/decisions/` directory (7 files).
- **Archived 6 aspirational plan docs** (`gap-remediation-plan.md`, `vrio-implementation-plan.md`, `autonomous-productivity.md`, `embedded-intelligence-roadmap.md`, `swarm-combination-plans.md`, `blackboard-response-schemas.md`) to `docs/archive/`.
- **Archived V2 design docs** (`ARCHITECTURE-V2.md`, `V2-STEP-6C.md`) to `docs/archive/`.
- **Updated `CLAUDE.md`** — reflects new doc structure, simplified reference list.
- **Updated `MEMORY.md`** — added operational rules section, test count = 2715, included `never-run-headless.md` in TOC.

### Active docs now (8 files)
```
CLAUDE.md                          # entry point
.opencode/session-checkpoint.md    # session state
docs/STATUS.md                     # current state + recent fixes
docs/active-work.md                # TODO list
docs/changelog.md                  # all changes + maintenance log
docs/decisions.md                  # 6 ADRs
docs/known-limitations.md          # trade-offs vs bugs
docs/model-behaviors.md            # model quirks
docs/swarm-patterns.md             # per-preset design
docs/AGENT-GUIDE.md                # day-1 essentials
```

## Files created
- `shared/src/modelConfig.ts` — single model resolution function
- `shared/src/modelConfig.test.ts` — 8 regression tests
- `docs/changelog.md` — consolidated change log + maintenance log
- `docs/decisions.md` — consolidated ADRs

## Files edited
- `web/src/components/SwarmView.tsx` — onNewSwarm navigates to /
- `server/src/routes/swarm.ts` — replaced 5 scattered model resolution blocks with resolveModels()
- `web/src/components/setup/TopologyGrid.tsx` — removed model overlay from localStorage recovery
- `server/scripts/run-tests.mjs` — registered modelConfig.test.ts
- `CLAUDE.md` — updated doc structure, removed decisions/ and MAINTENANCE-LOG references
- `docs/STATUS.md` — test count 2517→2715, added model consolidation + zombie fix entries
- `docs/active-work.md` — consolidated two 2026-05-17 entries, test count updated

## Files deleted
- `docs/decisions/` (7 files) → merged into `docs/decisions.md`
- `docs/MAINTENANCE-LOG.md` → merged into `docs/changelog.md`
- 6 aspirational plans moved to `docs/archive/`
- 2 V2 docs moved to `docs/archive/`

## Test counts
- Start: 2516
- End: **2715** (+199)
- All passing, zero failures
