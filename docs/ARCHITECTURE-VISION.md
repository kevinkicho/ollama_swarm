# Architecture Vision: Brain as Operating System

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
│  • Reporting back through the event system           │
│                                                      │
│  Workers are the PROCESSES.                          │
│  They do what the Orchestrator tells them.           │
└─────────────────────────────────────────────────────┘
```

---

## The Brain as Operating System

### Concept

The Brain is not just a post-run analyzer. It is a **persistent service** that:

1. **Monitors** the system in real-time (not just post-run)
2. **Analyzes** patterns across multiple runs
3. **Decides** what improvements to make
4. **Provisions** runs to implement those improvements
5. **Self-upgrades** when improvements are validated

Think of it like this:
- **Orchestrator** = kernel (manages resources, schedules tasks)
- **Brain** = user space (decides what to run, when, and why)
- **Workers** = threads (do the actual work)

### What Makes It an "Operating System"

| OS Concept | Brain Equivalent |
|------------|------------------|
| Process scheduler | Run provisioner (creates runs on demand) |
| System monitor | Interaction tracker + exception collector |
| Package manager | Proposal system (proposes + applies improvements) |
| Configuration manager | Pattern cache + patch cache (remembers what works) |
| Self-update | Self-upgrader (patches its own code) |

---

## What Exists Today

### Brain Components (built but partially wired)

| Component | File | Status |
|-----------|------|--------|
| Event chain tracker | `brainOverseer/interactionTracker.ts` | ✅ Built, wired into worker/replanner |
| Exception collector | `brainOverseer/exceptionCollector.ts` | ✅ Built, wired into worker/replanner |
| Pattern cache | `brainOverseer/patternCache.ts` | ✅ Built, disk-backed |
| Patch cache | `brainOverseer/patchCache.ts` | ✅ Built, content hashing |
| Brain orchestrator | `brainOverseer/brainOverseer.ts` | ⚠️ Rule-only proposals (no LLM) |
| Analysis prompt | `brainOverseer/prompt.ts` | ✅ Built but **never called** |
| Council adapter | `brainOverseer/councilBrainAdapter.ts` | ✅ Built but **never wired** |
| Brain fallback parser | `prompts/brainParser.ts` | ✅ Working (JSON decoder) |

### What's Missing

| Component | Status |
|-----------|--------|
| LLM-powered analysis | ❌ prompt.ts exists but never sent to LLM |
| Cross-run proposal persistence | ❌ Cache exists but proposals not stored |
| Real-time monitoring | ❌ Brain runs post-run only |
| Run provisioning | ❌ Brain can't start runs |
| Self-upgrade | ❌ Not started |
| UI for proposals | ❌ Not started |

---

## Path Forward

### Phase 2: Wire LLM Analysis (Near-term)

**Goal:** Make the brain actually analyze patterns using an LLM, not just rules.

**What exists:**
- `brainOverseer.ts` has `generateProposals()` which uses hardcoded rules
- `prompt.ts` has `buildAnalysisPrompt()` which builds a rich prompt for LLM analysis
- `councilBrainAdapter.ts` has `buildCouncilBrainDirective()` for council-based analysis

**What to do:**

1. **Call `prompt.ts` with a real LLM**
   - In `brainOverseer.ts`, replace `generateProposals()` with an actual LLM call
   - Use `buildAnalysisPrompt()` to format the chains + exceptions + prior improvements
   - Parse the LLM response into `ImprovementProposal[]`
   - This gives the brain real analytical power instead of just pattern matching

2. **Wire `councilBrainAdapter.ts`**
   - When the brain needs higher-quality proposals, trigger a council run
   - Use `buildCouncilBrainConfig()` to create a 3-agent council
   - Council analyzes the same data independently, then cross-examines
   - Majority vote selects the best proposals

3. **Show proposals in UI**
   - Create a `BrainProposalsPanel` component
   - Display proposals with title, description, priority, affected file
   - Add "Apply" / "Reject" buttons for each proposal
   - Store proposal state in the Zustand store

**Files to modify:**
- `brainOverseer/brainOverseer.ts` — add LLM call
- `brainOverseer/prompt.ts` — ensure prompt is complete
- `web/src/components/BrainProposalsPanel.tsx` — new UI component
- `web/src/state/store.ts` — add proposals state

**Estimated effort:** 6-8 hours

---

### Phase 3: Cross-Run Memory (Near-term)

**Goal:** Persist proposals and patterns across runs so the brain accumulates knowledge.

**What exists:**
- `patternCache.ts` — reads/writes `.swarm-improvements/pattern-cache.json`
- `patchCache.ts` — reads/writes `.swarm-improvements/patch-cache.json`
- `.swarm-memory.jsonl` — exists but not integrated

**What to do:**

1. **Persist proposals**
   - After brain analysis, write proposals to `.swarm-improvements/proposals.jsonl`
   - Each proposal has: id, title, description, priority, affectedFiles, status (pending/applied/rejected)
   - On next run, brain reads prior proposals to avoid duplicates

2. **Track applied proposals**
   - When a proposal is applied (patch committed), write to `.swarm-improvements/applied.jsonl`
   - Brain checks this before proposing the same improvement again

3. **Load prior context into planner**
   - In `plannerRunner.ts`, read pending proposals from `.swarm-improvements/`
   - Add them to the planner seed as "system improvement goals"
   - Planner can then create TODOs that implement the improvements

**Files to modify:**
- `brainOverseer/brainOverseer.ts` — persist proposals after analysis
- `plannerRunner.ts` — load prior proposals into seed
- `brainOverseer/prompt.ts` — include prior proposals in prompt

**Estimated effort:** 3-4 hours

---

### Phase 4: Brain Provisions Runs (Medium-term)

**Goal:** Brain can start runs on demand based on its analysis.

**What exists:**
- `Orchestrator.start(cfg)` — starts a run with a RunConfig
- `Orchestrator` has `maxConcurrentRuns` and `runs` Map
- Brain can generate proposals with affected files and priorities

**What to do:**

1. **Brain generates RunConfig**
   - From a proposal, generate a RunConfig:
     - `parentPath`: path to the project
     - `preset`: "blackboard" (for code changes)
     - `userDirective`: derived from the proposal
     - `agentCount`: based on proposal complexity
     - `continuous`: false (one-shot for specific improvements)

2. **Brain calls Orchestrator**
   - Give the brain a reference to the Orchestrator
   - Brain calls `orchestrator.start(cfg)` when it wants to implement a proposal
   - Brain can chain runs (finish one → start next)

3. **Brain monitors run health**
   - Subscribe to `SwarmEvent` stream in real-time
   - Track run progress, failures, and outcomes
   - Adjust parameters if a run is struggling (amendments, model swaps)

**Files to modify:**
- `brainOverseer/brainOverseer.ts` — add orchestrator reference, provision runs
- `Orchestrator.ts` — expose `brainStart(cfg)` API
- `brainOverseer/provisioner.ts` — new module for run provisioning logic

**Estimated effort:** 4-6 hours

---

### Phase 5: Self-Upgrade (Long-term)

**Goal:** Brain can modify its own code when improvements are validated.

**What exists:**
- `patchCache.ts` — content hashing for invalidation
- `applyAndCommit` in `WorkerPipeline.ts` — applies hunks and commits
- Git infrastructure for rollback

**What to do:**

1. **Self-upgrader module**
   - `brainOverseer/selfUpgrader.ts` — manages the upgrade lifecycle
   - Takes a proposal with hunks, applies them, commits, restarts
   - Safety: confidence threshold (≥0.8), git tag backup, dry-run mode

2. **Upgrade mode UI**
   - `web/src/components/UpgradeMode.tsx` — terminal-style display
   - Shows patch progress, verification results
   - User can approve/reject before application

3. **Rollback mechanism**
   - Before applying patches, create git tag `pre-brain-upgrade-{timestamp}`
   - If any patch fails verification, `git reset --hard HEAD~N`
   - Show error to user

**Files to create:**
- `brainOverseer/selfUpgrader.ts` — upgrade lifecycle
- `web/src/components/UpgradeMode.tsx` — terminal-style UI
- `web/src/components/UpgradePreview.tsx` — diff preview

**Estimated effort:** 12-16 hours

---

### Phase 6: Brain-as-OS (Long-term)

**Goal:** Brain becomes the persistent top-level process.

**What exists:**
- All brain components from Phases 2-5
- Orchestrator with multi-run support
- Concurrent run infrastructure

**What to do:**

1. **Brain as persistent service**
   - Brain runs as a long-lived Node.js process
   - Subscribes to `SwarmEvent` stream in real-time
   - Accumulates patterns across runs (not just one)
   - Has its own memory store

2. **Brain manages the Orchestrator**
   - Brain becomes the decision-maker
   - Orchestrator becomes a "syscall" layer
   - Brain decides: "run blackboard with directive X"
   - Orchestrator executes: `orchestrator.start(cfg)`

3. **Brain monitors system health**
   - Real-time monitoring of all runs
   - Detects issues as they happen (not just post-run)
   - Can pause/stop/resume runs based on patterns
   - Adjusts parameters mid-run (amendments, model swaps)

4. **Brain self-upgrades**
   - When improvements are validated, brain patches its own code
   - Git commits each patch
   - Restarts the server
   - Rollback on failure

**Files to modify:**
- `brainOverseer/brainOverseer.ts` — persistent service, real-time monitoring
- `Orchestrator.ts` — demoted to subsystem, exposes `brainStart(cfg)`
- `index.ts` — brain as top-level process

**Estimated effort:** 20-30 hours

---

## Brain Coordination: System Work vs Project Work

### The Problem

The brain has two types of work:
1. **System work** — patches, upgrades, configuration changes (modifies swarm code)
2. **Project work** — runs implementing improvements (modifies project code)

These can conflict if done simultaneously.

### The Solution: Serialized Queue

```
Brain Queue:
  ┌─────────────────────────────────────┐
  │ 1. System patches (HIGH priority)   │ ← Serialized, one at a time
  │ 2. Project runs (MEDIUM priority)   │ ← Can be parallel
  │ 3. Analysis (LOW priority)          │ ← Background
  └─────────────────────────────────────┘
```

### Rules

1. **System work first** — Patches must complete before project runs start
2. **Patches only when idle** — Patch application only happens when ALL runs are stopped
3. **No concurrent system work** — Only one patch at a time
4. **Project runs can parallel** — Multiple runs if no file conflicts

### Why This Matters

If the brain provisions a run AND applies a patch simultaneously:
- Run modifies `config/dashboardPanels.js`
- Patch modifies `workerRunner.ts`
- No conflict (different files)

But if both modify the same file:
- Run modifies `workerRunner.ts`
- Patch modifies `workerRunner.ts`
- **CONFLICT**

The queue prevents this by serializing system work.

---

## Implementation Priority

| Phase | Priority | Effort | Impact |
|-------|----------|--------|--------|
| P2: Wire LLM Analysis | High | 6-8 hr | Brain actually thinks |
| P3: Cross-Run Memory | High | 3-4 hr | Brain remembers |
| P4: Brain Provisions Runs | Medium | 4-6 hr | Brain acts |
| P5: Self-Upgrade | Low | 12-16 hr | Brain improves itself |
| P6: Brain-as-OS | Low | 20-30 hr | Brain is the OS |

**Recommendation:** Start with P2+P3 (near-term). This gets the brain from "runs but produces nothing useful" to "runs and accumulates knowledge" without restructuring the entire lifecycle.

---

## Key Architectural Decisions

1. **Brain is persistent, not per-run** — Brain exists outside the `ActiveRun` map
2. **Orchestrator is a subsystem** — Brain calls Orchestrator, not the other way around
3. **Proposals are first-class** — Brain proposals are stored, tracked, and can be applied
4. **Self-upgrade is opt-in** — Brain must get user approval before patching code
5. **Rollback is mandatory** — Every self-upgrade creates a git tag for rollback
6. **System work before project work** — Patches must complete before runs start
7. **Patches only when idle** — Patch application only happens when ALL runs are stopped
