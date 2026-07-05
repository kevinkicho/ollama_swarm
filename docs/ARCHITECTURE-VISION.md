# Architecture Vision: Brain as Operating System

> **Status (2026-07):** This is the original north-star vision document.
> **Many phases are now implemented** (LLM analysis, cross-run memory, provisioning, self-upgrader, SystemWrapper UI, Brain panels, concurrent run management). 
> Brain-as-OS components are real and wired under `server/src/swarm/blackboard/brainOverseer/`.
> See `docs/STATUS.md` and `docs/active-work.md` for current shipped state.
> This doc is kept for long-term direction. "Path Forward" sections below are historical plans.

> This document describes the target architecture for ollama_swarm.
> It serves as the north-star for all development work.

---

## Three-Layer Architecture

```
┌─────────────────────────────────────────────────────┐
│                 BRAIN LAYER                          │
│  (agent-0 or council of agents)                      │
│                                                      │
│  • Monitors system health across all runs            │
│  • Detects recurring failure patterns                │
│  • Proposes improvements to the swarm system         │
│  • Provisions runs on demand based on proposals      │
│  • Self-upgrades when improvements are validated     │
│                                                      │
│  The Brain is the OPERATING SYSTEM of the app.       │
│  It decides WHAT to do and WHEN.                     │
└─────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│              ORCHESTRATOR LAYER                      │
│                                                      │
│  • Manages concurrent run lifecycle                  │
│  • Routes work to the appropriate runner             │
│  • Handles failures, retries, and recovery           │
│  • Provides APIs for the Brain and UI                │
│                                                      │
│  The Orchestrator is the SYSCALL interface.          │
│  It executes what the Brain decides.                 │
└─────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│              WORKER LAYER                            │
│                                                      │
│  • Individual agents doing concrete work             │
│  • Following system prompts (planner, worker, etc.)  │
│  • Producing output (hunks, todos, verdicts)         │
│                                                      │
│  The Workers are the APPLICATIONS.                   │
└─────────────────────────────────────────────────────┘
```

---

## Current Implementation Status (2026-07)

Most of the Brain layer is live:

- Brain analysis and proposal generation (safe recording only)
- Cross-run memory and librarian functions
- Run provisioning from proposals
- SystemWrapper UI with persistent Brain FAB, panels, and activity
- During-run Brain chat (`/brain/chat`) with full run context
- Proactive suggestion injection
- Health monitoring and caps integration

See `docs/STATUS.md` for the exact shipped matrix.

---

## Path Forward (Historical)

(Kept for reference; many items have been completed or evolved.)

The long-term goal is for the Brain to become a first-class autonomous operator:

1. **Full self-upgrader** (currently recording-only)
2. **Automatic run provisioning** based on detected needs
3. **Cross-run learning** feeding into future preset selection
4. **Human-in-the-loop only at high level** (approve major upgrades)

This vision drives the priority of Brain-related work over adding yet another preset.
