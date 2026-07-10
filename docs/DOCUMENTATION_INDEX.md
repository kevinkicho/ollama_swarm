# Documentation Index

This is the structured index of all relevant, tracked documentation for the ollama_swarm project.

**Rule**: Only documentation that describes the app, architecture, usage, decisions, and current state is tracked. Runtime metadata, run logs, test records, one-time artifacts, generated outputs (`.swarm-design/`, `.swarm-improvements/`, logs, screenshots, `.last_rid.txt`, etc.) are intentionally **not tracked**.

## Entry Points (Start Here)

- **README.md** (root)  
  The public face of the repository on GitHub. Quickstart, high-level overview, presets, CLI usage, and tour.

- **docs/STATUS.md**  
  The single authoritative "what's true right now" document. Current features, architecture summary, recent work, active constraints, and observability stack. Read this first if you're an agent or new contributor.

- **docs/AGENT-GUIDE.md**  
  Day-to-day operational guide for humans and AI agents. Commands, dev workflow, tools & internet access, debugging, server restarts, etc.

## Core Guides

- **docs/CI-RELIABILITY.md**  
  How to keep CI green. The `verify-ci` process, pre-push hooks, common footguns, and best practices.

- **docs/known-limitations.md**  
  Honest trade-offs and deliberate limitations of the current system.

- **docs/run-stop-drain-lifecycle.md**  
  Canonical stop/drain/close-out contract (hard vs soft stop, council execution wait,
  transcript ordering, debugging checklist). Read when messages appear after “ports released”.

- **docs/swarm-patterns.md**
  Recommended usage patterns by preset and use case (full catalog of the presets). Research/webTools guidance lives in README and STATUS.md. (Hybrid mode removed 2026-07.)

## Architecture & Vision

- **docs/ARCHITECTURE-VISION.md**  
  The long-term north-star vision for the project.

- **server/src/swarm/blackboard/ARCHITECTURE.md**  
  Deep technical architecture of the blackboard / V2 substrate.

- **docs/BRAIN-OS-FOR-EXTERNAL-AGENTS.md**  
  How external agents and Brain loops can interact with and drive the system.

## Operational & Historical

- **docs/decisions.md**  
  Key architectural and product decisions. Includes **2026-07-08: no `:cloud`
  admission throttling**, **2026-07-09: no stream-guard aborts**, and
  **2026-07-10: no Jaccard primary loop gate**.

- **docs/postmortems/stream-guards-removed.md**  
  Why stream/Jaccard guards were removed; what remains valid (empty-output, caps).

- **docs/changelog.md**  
  Historical change log.

- **scripts/_dead-code-scan.mjs** + **scripts/_dead-code-report.md**  
  Import-graph dead-module scan and last report (re-run after large refactors).

- **docs/model-behaviors.md**  
  Observed behaviors of different models in this system.

- **docs/INITIALIZATION-SEQUENCE.md**  
  How the system boots and initializes.

- **docs/active-work.md**  
  Currently active / in-flight work items.

- **docs/plans/PENDING-WORK.md**  
  Planned future work.

- **docs/plans/agent-activity-signaling.md**  
  Study notes: streaming vs sidebar status, missing activity protocol (recall before signaling refactor).

- **docs/plans/event-log-performance.md**  
  Debug Log list/replay performance: shipped fast-path (Jul 2026) and queued PRs (meta sidecar, pagination, indexes).

- **docs/plans/project-growth-knowledge-graph.md**  
  Swarm-evolution graph (user UX), per-clone project knowledge graph (user + in-run agents), conformance grounding, and digression recovery — phased PR plan (Jul 2026).

- **docs/postmortems/run-d3a99661.md**  
  Postmortem for council run `d3a99661` (cycle failures, synthesis loops).

- **docs/postmortems/run-94224a3e.md**  
  Postmortem for blackboard run `94224a3e` (`no-progress`: expectedFiles truncation + grounding, not JSON repair).

- **docs/postmortems/run-4b2da092.md**  
  Postmortem for blackboard run `4b2da092` (crash during pending-commit; parse-salvage / think-tag envelope issues).

- `docs/archive/` and `docs/plans/archive/`  
- `docs/postmortems/`  
  Per-run postmortems (not runtime logs).
  Historical plans and old documents (kept for context).

## Other Documentation

- `eval/README.md` and fixture READMEs  
  Documentation for the evaluation harness and test fixtures.

## What Is Not Tracked

These are deliberately excluded from version control (see `.gitignore`):

- Runtime state: `.last_rid.txt`, `.swarm-memory.jsonl`
- Brain-generated artifacts: `.swarm-design/`, `.swarm-improvements/`
- Logs and outputs: `logs/`, `screenshots/`, `server.err` / `server.out`, deliverable files inside logs
- Run / session artifacts: entire `runs/`, `terminals/`, `agent-tools/`
- MCP schema dumps: `mcps/` (not loaded by the app runtime)
- Per-clone operational files: `blackboard-state.json`, `run-state.json*`, `.server-port`
- Environment and build artifacts: `.env*`, `node_modules/`, `dist/`, `build/`, `*.log`

Only the documentation listed above (and actual source code) is kept in the repository.

## Research Quick Links

- README.md → "Using for Scientific Research & Internet Work" (webTools guidance).
- STATUS.md → research paragraph + full preset table (maturity, write capability).
- Note: Hybrid mode removed 2026-07 (no `useHybridPlanning` etc.). Use `pipeline` preset for chaining.
- `server/src/swarm/presetGuide.ts` — source of truth for preset descriptions fed to Brain.

## Key Implementation Locations (for agents + developers)

- **Orchestration & runs**: `server/src/services/Orchestrator.ts`, `server/src/services/ActiveRun.ts`
- **Blackboard substrate (writes, TodoQueue, auditor, CAS)**: `server/src/swarm/blackboard/` (WorkerPipeline.ts, TodoQueue.ts, v2Adapters.ts, auditorRunner.ts, RunStateObserver.ts)
- **Tools & sandbox**: `server/src/tools/ToolDispatcher.ts`, `resolveSafe.ts`, `buildCommandAllowlist.ts`
- **Providers**: `server/src/providers/` (pickProvider.ts + 5 impls)
- **Brain-as-OS**: `server/src/swarm/blackboard/brainOverseer/`
- **Web UI (per-run stores, transcript, Brain FAB)**: `web/src/` (App.tsx, state/SwarmStoreProvider.tsx, components for transcript/board/brain)
- **Transcript text hygiene (shared)**: `shared/src/stripAgentText.ts`, `extractToolCallMarkers.ts`, `parseThinkingDisplay.ts`, `parseAgentJson.ts`
- **CLI**: `bin/ollama-swarm.mjs`
- **Eval harness**: `eval/run-eval.mjs`, `eval/aggregate.mjs`, `eval/catalog.json`

## Quick Reading Order Recommendation

For a new person or agent:

1. README.md
2. docs/STATUS.md
3. docs/AGENT-GUIDE.md
4. docs/CI-RELIABILITY.md
5. docs/known-limitations.md
6. README "Using for Scientific Research" + STATUS preset table (for research work)
7. Dive into architecture docs + blackboard/ source as needed.

Last updated: 2026-07-08 (project growth / knowledge graph plan)
