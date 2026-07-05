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

- **docs/swarm-patterns.md**  
  Recommended usage patterns by preset and use case (full catalog of the 12 presets). Research/hybrid + webTools guidance lives in README and STATUS.md.

## Architecture & Vision

- **docs/ARCHITECTURE-VISION.md**  
  The long-term north-star vision for the project.

- **server/src/swarm/blackboard/ARCHITECTURE.md**  
  Deep technical architecture of the blackboard / V2 substrate.

- **docs/BRAIN-OS-FOR-EXTERNAL-AGENTS.md**  
  How external agents and Brain loops can interact with and drive the system.

## Operational & Historical

- **docs/decisions.md**  
  Key architectural and product decisions.

- **docs/changelog.md**  
  Historical change log.

- **docs/model-behaviors.md**  
  Observed behaviors of different models in this system.

- **docs/INITIALIZATION-SEQUENCE.md**  
  How the system boots and initializes.

- **docs/active-work.md**  
  Currently active / in-flight work items.

- **docs/plans/PENDING-WORK.md**  
  Planned future work.

- `docs/archive/` and `docs/plans/archive/`  
  Historical plans and old documents (kept for context).

## Other Documentation

- `eval/README.md` and fixture READMEs  
  Documentation for the evaluation harness and test fixtures.

- `PROJECT-REVIEW.md` and `PROJECT-REVIEW-2026-07-04.md`  
  Project review notes.

## What Is Not Tracked

These are deliberately excluded from version control (see `.gitignore`):

- Runtime state: `.last_rid.txt`, `.swarm-memory.jsonl`
- Brain-generated artifacts: `.swarm-design/`, `.swarm-improvements/`
- Logs and outputs: `logs/`, `screenshots/`, deliverable files inside logs
- Test / debug artifacts: `*.rid.txt`, temporary capture scripts, `runs/_*` diagnose dirs
- Per-clone operational files: `blackboard-state.json`, `run-state.json*`, `.server-port`
- Environment and build artifacts: `.env*`, `node_modules/`, `dist/`, `build/`, `*.log`

Only the documentation listed above (and actual source code) is kept in the repository.

## Hybrid / Research Quick Links

- README.md → "Using for Scientific Research & Internet Work" (webTools + `useHybridPlanning`, planner vs execution presets, example config).
- STATUS.md → research paragraph + full preset table (maturity, write capability).
- `server/src/swarm/presetGuide.ts` — source of truth for preset descriptions fed to Brain.

## Key Implementation Locations (for agents + developers)

- **Orchestration & runs**: `server/src/services/Orchestrator.ts`, `server/src/services/ActiveRun.ts`
- **Blackboard substrate (writes, TodoQueue, auditor, CAS)**: `server/src/swarm/blackboard/` (WorkerPipeline.ts, TodoQueue.ts, v2Adapters.ts, auditorRunner.ts, RunStateObserver.ts)
- **Tools & sandbox**: `server/src/tools/ToolDispatcher.ts`, `resolveSafe.ts`, `buildCommandAllowlist.ts`
- **Providers**: `server/src/providers/` (pickProvider.ts + 5 impls)
- **Brain-as-OS**: `server/src/swarm/blackboard/brainOverseer/`
- **Web UI (per-run stores, transcript, Brain FAB)**: `web/src/` (App.tsx, state/SwarmStoreProvider.tsx, components for transcript/board/brain)
- **CLI**: `bin/ollama-swarm.mjs`
- **Eval harness**: `eval/run-eval.mjs`, `eval/aggregate.mjs`, `eval/catalog.json`

## Quick Reading Order Recommendation

For a new person or agent:

1. README.md
2. docs/STATUS.md
3. docs/AGENT-GUIDE.md
4. docs/CI-RELIABILITY.md
5. docs/known-limitations.md
6. README "Using for Scientific Research" + STATUS preset table (for hybrid/research work)
7. Dive into architecture docs + blackboard/ source as needed.

Last updated: 2026-07-05 (post doc hygiene + Research Workflows reference cleanup)
