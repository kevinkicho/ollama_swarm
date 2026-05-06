# ADR 006: Implementation Roadmap — 7 Strategic Directions

> Date: 2026-05-06
> Status: proposed
> Depends on: commit e96d002 (7 combination plans + runner refactor)

This document provides concrete implementation plans for the 7 strategic directions identified for the ollama_swarm platform. Each plan is organized into phases with estimated effort, key files, and dependencies.

---

## Direction 1: Self-Improving Orchestration

**Goal:** The system learns which presets, hyperparams, and patterns produce the best results for which tasks, and applies that knowledge automatically.

### Phase 1 — Run Outcome Scoring (2-3 days)

**New files:**
- `server/src/swarm/outcomeScorer.ts` (~120 LOC) — scores completed runs
- `server/src/swarm/outcomeScorer.test.ts` (~80 LOC)

**Implementation:**

```ts
interface RunOutcome {
  runId: string;
  preset: PresetId;
  agentCount: number;
  rounds: number;
  wallClockMs: number;
  tokenUsage: { prompt: number; completion: number };
  costUsd: number;
  score: number;        // 0-1 composite
  dimensions: {
    completeness: number;  // did the run address the full directive?
    correctness: number;   // do hunks apply cleanly? tests pass?
    efficiency: number;    // tokens per quality point
    convergence: number;    // did agents reach agreement?
  };
  userRating?: number;   // optional explicit 1-5 stars
}
```

Scoring is **multi-dimensional**:
- `completeness`: LLM grader reads directive + final deliverable, scores 0-1
- `correctness`: `applyHunks()` success rate + test pass delta (if repo has tests)
- `efficiency`: `score / (tokenUsage.completion / 1000)` — quality per token
- `convergence`: for discussion presets, measure agreement between rounds (embeddings or text similarity of successive agent responses)

The grader prompt is a single `chatOnce` call with structured output (`ollamaFormat: { type: "object", properties: { completeness: { type: "number" }, ... } }`). It uses the cheapest available model (currently `gemma3:4b`).

**Where it hooks in:**
- `Orchestrator.ts` — after `runner.start()` completes, call `scoreRun(runId, cfg, transcript, deliverable)` 
- `SwarmRunner.ts` — add `RunOutcome` to `SwarmStatus`
- `SwarmEvent` — add `outcome_scored` event body

**Storage:** Write outcome to `<clone>/outcome-<runId>.json` alongside existing summaries. Also append to `server/data/outcome-history.jsonl` (append-only log, one JSON per line).

### Phase 2 — Outcome History + Regression Analysis (2-3 days)

**New files:**
- `server/src/swarm/outcomeHistory.ts` (~150 LOC) — reads/writes the outcome log
- `server/src/swarm/presetRecommender.ts` (~200 LOC) — learns from outcomes

**Implementation:**

`OutcomeHistory` class:
- `record(outcome)` — appends to JSONL
- `query(filters)` — returns matching outcomes (by preset, model, agentCount, score range)
- `stats(preset)` — returns `{ avgScore, avgEfficiency, sampleSize, confidence }` per preset
- `topPresetForTags(tags[])` — keyword-match directive tags to outcomes

`PresetRecommender`:
- Given a `userDirective`, extract keywords → look up `OutcomeHistory.stats()` → recommend preset + params
- Falls back to existing `heuristicPickPreset()` when < 5 data points for a given tag/preset combo
- Exposes `recommendPreset(directive, history)` → `{ preset, confidence, rationale }` that the `/start` route calls before building the runner

**Route change:** `POST /api/swarm/start` gains optional `autoRecommend: true` param. When set, the router consults `PresetRecommender` before the user's explicit preset choice is used. The rationale is included in the response.

### Phase 3 — Adaptive Hyperparameters (3-4 days)

**New files:**
- `server/src/swarm/adaptiveParams.ts` (~200 LOC) — learns optimal params per preset

**Implementation:**

Build a lightweight regression model over outcome dimensions:

```
score ≈ f(preset, agentCount, rounds, model, directive_complexity)
```

For each preset, track:
- Optimal `agentCount` range (min score delta per added agent)
- Optimal `rounds` (diminishing returns point)
- Best `model` per directive complexity tier

The function `adaptiveParams(preset, directive, history)` returns partial `RunConfig` overrides. These get merged with user-provided config, with user values always winning when explicitly set.

**No ML framework required** — this is simple grouped statistics (mean, confidence intervals, Bayesian averaging against a uniform prior). When sample size < 10 for a param combo, fall back to defaults in `SwarmRunner.ts`.

### Phase 4 — Continuous Learning Loop (1-2 days)

**Implementation:**
- Cron-like sweep: every N runs (or on demand), recompute group statistics
- Decay old outcomes (weight recent outcomes more — exponential decay with half-life of ~7 days)
- Expose `GET /api/outcome/stats` for the UI to show a dashboard
- Expose `GET /api/outcome/recommend?directive=...` for pre-flight preset suggestion

**UI additions (web):**
- After each run, show a "Rate this result" widget (1-5 stars + optional text)
- Settings page: "Learning mode" toggle — when off, no auto-recommendation; when on, the system suggests params before runs
- Simple dashboard showing the last 20 outcomes grouped by preset

**Dependencies:** Phase 1 → Phase 2 → Phase 3 → Phase 4 (sequential).

**Risk:** LLM grader quality. Mitigate with structured output constraints and a fallback to `userRating` when available.

---

## Direction 2: Hierarchical Swarms

**Goal:** Runs whose agents are themselves swarms. A blackboard's workers can delegate to sub-swarms (council, debate, map-reduce). Enables genuine 20+ agent scale.

### Phase 1 — Sub-Run Protocol (3-4 days)

**New files:**
- `server/src/swarm/SubRunProtocol.ts` (~150 LOC) — defines the contract between parent and child runners

**Key types:**

```ts
interface SubRunRequest {
  parentRunId: string;
  subRunId: string;          // UUID minted by parent
  preset: PresetId;
  directive: string;         // parent-scoped task
  context: string;           // transcript excerpts + deliverable so far
  agentCount: number;
  rounds: number;
  model?: string;
  timeoutMs: number;        // parent imposes a deadline
}

interface SubRunResult {
  subRunId: string;
  status: "completed" | "stopped" | "failed" | "timed_out";
  deliverable: string;      // final synthesis text
  transcript: TranscriptEntry[];
  outcome?: RunOutcome;
  costUsd: number;
  tokenUsage: { prompt: number; completion: number };
}
```

**Where it hooks in:**
- `Orchestrator.ts` — `startSubRun(request: SubRunRequest)` creates a child runner with a scoped clone, bounded lifecycle, and auto-stop on timeout. The parent holds a `SubRunHandle` with `await result()` and `cancel()`.
- The sub-run's `emit` is scoped: events are tagged with `parentRunId` + `subRunId` and forwarded as `sub_run_event` parent events, not broadcast directly.
- Sub-runs use a separate clone directory (symlink or shallow clone) to avoid CAS conflicts.

### Phase 2 — Blackboard Worker Delegation (3-4 days)

**Modified files:**
- `server/src/swarm/blackboard/workerRunner.ts` — add sub-run path
- `server/src/swarm/blackboard/BlackboardRunner.ts` — manage sub-run lifecycle

**Implementation:**

When `cfg.workerDelegation` is set (new `RunConfig` field), blackboard workers get an option to "delegate" a todo instead of completing it directly. The worker's prompt includes:

```
If this task is too complex for a single agent, respond with:
DELEGATE_SUB_SWARM <preset> <directive>
Example: DELEGATE_SUB_SWARM council "Review this authentication refactor for security issues"
```

`workerRunner.ts` detects `DELEGATE_SUB_SWARM` in the worker response, parses preset + directive, and calls `orchestrator.startSubRun(...)`. The sub-run result is used as the worker's "proposal" — feed the deliverable back through the normal hunk pipeline.

**Key constraint:** Only 1 level of nesting. If a sub-swarm itself tries to delegate, it's ignored (prompt constraint + server-side enforcement).

**Resource bounds:**
- Max 2 concurrent sub-runs per blackboard run (configurable `maxSubRuns`)
- Sub-run inherits parent's `maxCostUsd` budget, divided by (1 + maxSubRuns)
- Sub-run timeout: 60% of parent's remaining wall-clock budget

### Phase 3 — Pipeline as Hierarchical Coordinator (2 days)

**Modified files:**
- `server/src/swarm/PipelineRunner.ts` — use SubRunProtocol

**Implementation:**
PipelineRunner already chains sub-runs. Refactor it to use the `SubRunProtocol` so pipeline phases are proper sub-runs with outcomes scored, budgets tracked, and events properly nested. This is a thin refactor — the logic is the same, just using the formalized protocol.

### Phase 4 — UI for Hierarchical Runs (2-3 days)

**Modified files:**
- `web/src/components/transcript/MessageBubble.tsx` — render `sub_run_event` with collapsible sections
- `web/src/state/applyEvent.ts` — handle nested event structure

**Implementation:**
- Sub-run events render as collapsible "zoom-in" panels in the transcript
- Clicking "expand" loads the sub-run's full transcript inline
- Status bar shows nested structure: "Blackboard → Worker 3 → Council (3 agents, round 2/3)"

**Dependencies:** Phase 1 → Phase 2 + Phase 3 (parallel) → Phase 4.

**Risk:** Clone management for concurrent sub-runs. Mitigate with shallow clones + file-level locking. Cost blow-up from nested runs. Mitigate with strict budget inheritance.

---

## Direction 3: Streaming Deliverable Merging (CRDT-for-Code)

**Goal:** Multiple agents write to the same files concurrently, with real-time conflict resolution. Moves from "discuss then write" to "write live together."

### Phase 1 — Operational Transform for Hunk Application (4-5 days)

**New files:**
- `server/src/swarm/streamMerge/OTEngine.ts` (~250 LOC) — operational transform for text hunks
- `server/src/swarm/streamMerge/OTEngine.test.ts` (~150 LOC)
- `server/src/swarm/streamMerge/types.ts` (~50 LOC)

**Key types:**

```ts
interface HunkOp {
  id: string;               // UUID
  agentId: string;
  file: string;
  type: "replace" | "insert" | "delete";
  anchor: string;           // context anchor (like existing Hunk.search)
  content: string;
  timestamp: number;
  baseRevision: number;     // the file revision this op was based on
}

interface MergeResult {
  accepted: HunkOp[];
  rejected: HunkOp[];      // with rejection reason
  conflicts: Conflict[];
  resultingRevision: number;
}
```

**OT algorithm:**
1. Each file has a monotonically increasing revision number
2. New `HunkOp` arrives → OTEngine checks `baseRevision` against current revision
3. If `baseRevision === current`: apply directly, bump revision
4. If `baseRevision < current`: transform the op against all intervening ops, then apply (standard OT composition)
5. If transformation fails (true conflict): queue for agent to resolve or auto-merge (use existing `reconcileHunks.ts` merge strategy)

**This is OT, not CRDT** — true CRDTs for code are extremely hard (GOTCHA problem). OT with a central server (which we have) is simpler and correct.

### Phase 2 — StreamMergeRunner for Discussion Presets (3-4 days)

**New files:**
- `server/src/swarm/streamMerge/StreamMergeCoordinator.ts` (~200 LOC)
- `server/src/swarm/streamMerge/StreamMergeCoordinator.test.ts` (~100 LOC)

**Modified files:**
- `server/src/swarm/DiscussionRunnerBase.ts` — add `streamMerge` mode option

**Implementation:**

When `cfg.writeMode === "stream"` (new mode alongside "none"/"single"/"multi"):

1. Each agent's `runDiscussionAgent()` call also streams its output in real-time
2. `StreamMergeCoordinator` receives partial output events, parses hunks as they appear (incremental JSON parsing)
3. Hunks are applied via OTEngine as soon as a complete hunk is detected
4. Later agents see the merged state from earlier agents in the same round
5. Conflicts are flagged and queued for resolution (auto-merge for non-overlapping, human-in-the-loop for true conflicts in future phase)

**Agent prompt change:** In stream mode, the prompt says "You are editing LIVE. Other agents may have already made changes. Always re-read the current file state before editing." The file context injected into the prompt is the *current merged state*, not the original.

### Phase 3 — Real-Time UI (2-3 days)

**Modified files:**
- `web/src/components/transcript/StreamingDock.tsx` — render live file diffs
- `web/src/state/applyEvent.ts` — handle `stream_merge_apply` and `stream_merge_conflict` events
- `web/src/types.ts` — new event types

**Implementation:**
- New `stream_merge_apply` event: { file, hunk, author, revision }
- New `stream_merge_conflict` event: { file, conflictingAgents, hunkPreview }
- UI shows split-pane: left is the merged output (live-updating), right is the agent transcript
- Conflicts render as highlight regions in the merged output with "Accept A / Accept B / Manual resolve" buttons

### Phase 4 — Conflict Resolution Strategies (2-3 days)

**New files:**
- `server/src/swarm/streamMerge/conflictStrategies.ts` (~150 LOC)

**Implementation:**
Extend existing `reconcileHunks.ts` strategies to work with `HunkOp`:
- `merge`: apply non-conflicting, auto-merge small text overlaps with contextual merge markers
- `sequential`: apply in arrival order, first-writer-wins for true conflicts
- `vote`: conflict triggers a quick poll among agents (1-round vote)
- `judge`: dedicated judge agent reviews the conflict and picks a winner

**Dependencies:** Phase 1 → Phase 2 → Phase 3 + Phase 4 (parallel).

**Risk:** Incremental JSON parsing of streaming LLM output. Hunks may be malformed mid-stream. Mitigate with a "complete hunk detector" regex that waits for closing `}` before applying. Also risk of agents undoing each other's work in stream mode — mitigate with prompt guardrails and OT composition.

---

## Direction 4: Task Decomposition (Issue-to-PR)

**Goal:** User gives a GitHub issue URL or plain-text task, the swarm decomposes it into sub-tasks, assigns each to the right preset, runs them in parallel where possible, and merges into a PR.

### Phase 1 — Task Decomposer Agent (2-3 days)

**New files:**
- `server/src/swarm/decomposer/TaskDecomposer.ts` (~200 LOC)
- `server/src/swarm/decomposer/decomposerPrompts.ts` (~100 LOC)

**Implementation:**

```ts
interface SubTask {
  id: string;
  title: string;
  description: string;
  preset: PresetId;
  agentCount: number;
  rounds: number;
  model?: string;
  dependencies: string[];    // sub-task IDs this depends on
  files: string[];           // predicted affected files
  priority: number;          // 0 = highest
}

interface Decomposition {
  subTasks: SubTask[];
  criticalPathLength: number;
  estimatedRounds: number;
}
```

`TaskDecomposer.decompose(directive, repoContext)`:
1. Fetch repo context: file tree, recent commits, README, package.json (already available from `RepoService`)
2. One LLM call with structured output (`ollamaFormat` + JSON schema for `Decomposition`)
3. The prompt lists all 12 presets with descriptions, asks for optimal assignment
4. Validates output: each sub-task references a valid preset, dependency graph is a DAG, no orphan nodes

**The decomposer is itself a single LLM call** — no need for a swarm to decompose. This keeps it fast and cheap.

### Phase 2 — Dependency Graph Executor (3-4 days)

**New files:**
- `server/src/swarm/decomposer/DagExecutor.ts` (~250 LOC)
- `server/src/swarm/decomposer/DagExecutor.test.ts` (~150 LOC)

**Implementation:**

```ts
class DagExecutor {
  constructor(
    private runnerFactory: (preset: PresetId) => SwarmRunner,
    private orchestrator: Orchestrator
  ) {}

  async execute(decomposition: Decomposition, cfg: RunConfig): Promise<SubTaskResult[]> {
    // Topological sort of sub-tasks by dependency edges
    // Execute layers in parallel: all tasks with 0 unmet dependencies start together
    // Each completed task unlocks its dependents
    // Returns results in completion order
  }
}
```

Key behaviors:
- **Parallel execution**: Tasks in the same dependency layer run concurrently (subject to `maxConcurrentRuns` budget)
- **Context passing**: Each sub-task receives its dependencies' deliverables as context
- **Budget sharing**: Parent run's `maxCostUsd` is distributed across sub-tasks proportionally
- **Failure handling**: If a sub-task fails, dependent tasks get a partial context + error note. They can still attempt to run.

**Where it hooks in:**
- `Orchestrator.ts` — new `startDecomposedRun(cfg)` method
- `routes/swarm.ts` — new `POST /api/swarm/start-decomposed` endpoint accepting same `StartBody` but with `decompose: true`
- Uses `SubRunProtocol` from Direction 2 for each sub-run

### Phase 3 — PR Assembly (2-3 days)

**New files:**
- `server/src/swarm/decomposer/PrAssembler.ts` (~200 LOC)

**Implementation:**

After the DAG completes, `PrAssembler`:
1. Collects all sub-task deliverables + hunks
2. Runs `reconcileHunks()` across all sub-tasks' proposals (using `merge` strategy by default)
3. Applies the merged hunks to a git branch
4. Generates a PR description from the decomposition + deliverables
5. Creates a PR via GitHub API (`gh pr create`)
6. Optionally runs CI and waits for green

**Prerequisite:** Git authentication configured. Could use `gh` CLI (already likely available on dev machines) or GitHub API directly.

### Phase 4 — Issue Intake (1-2 days)

**New files:**
- `server/src/routes/intake.ts` (~100 LOC) — new route file

**Implementation:**
- `POST /api/swarm/start-from-issue` accepts `{ issueUrl, preset?: PresetId, autoDecompose?: boolean }`
- Fetches issue via GitHub API (`gh issue view <number> --json title,body,labels`)
- Extracts title + body as the directive
- If `autoDecompose`, calls `TaskDecomposer.decompose()` then `DagExecutor.execute()`
- Otherwise, runs as a single preset (existing flow)

**UI additions:**
- New "From Issue" button on the setup form
- Input for GitHub issue URL
- Toggle: "Auto-decompose" vs "Single preset"
- Task graph visualization showing sub-tasks + dependencies

**Dependencies:** Phase 1 → Phase 2 → Phase 3 + Phase 4 (parallel). Direction 2 (SubRunProtocol) is a prerequisite for Phase 2.

**Risk:** LLM decomposition quality. Mitigate with structured output constraints and a "review decomposition before running" step in the UI.

---

## Direction 5: Persistent Agent Memory Across Runs

**Goal:** Agents remember project conventions, past mistakes, review feedback, and codebase patterns across runs. The pheromone heatmap is a seed; this extends it into a project-level knowledge base.

### Phase 1 — Memory Store (2-3 days)

**New files:**
- `server/src/memory/MemoryStore.ts` (~200 LOC) — persistent key-value store
- `server/src/memory/MemoryStore.test.ts` (~100 LOC)
- `server/src/memory/types.ts` (~50 LOC)

**Implementation:**

```ts
interface MemoryEntry {
  key: string;              // namespaced path e.g. "project/conventions/prefer-immutability"
  value: string;            // the memory content
  source: "agent" | "user" | "auto";
  confidence: number;      // 0-1, decays over time
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
  tags: string[];           // e.g. ["typescript", "conventions", "codestyle"]
}

class MemoryStore {
  // Stored at <repo>/swarm-memory.json (git-ignored, per-project)
  // In-memory Map + debounce write to disk
  
  store(key: string, value: string, tags?: string[]): void;
  query(query: string, topK?: number): MemoryEntry[];   // keyword + embedding search
  forget(key: string): void;
  decay(halfLifeDays?: number): void;                     // age-based pruning
  snapshot(): MemoryEntry[];
}
```

**Storage:** `<clone>/swarm-memory.json` — a single JSON file per repo. Loaded on run start, written on run end. Simple and debuggable.

**Search:** Keyword matching initially (split query into tokens, match against `tags` + `key`). Phase 2 adds embedding-based semantic search.

### Phase 2 — Auto-Memory Extraction (2-3 days)

**New files:**
- `server/src/memory/MemoryExtractor.ts` (~150 LOC) — extracts memories from run transcripts
- `server/src/memory/MemoryExtractor.test.ts` (~80 LOC)

**Implementation:**

After each run completes, `MemoryExtractor` is called with the transcript + deliverable:

1. **Convention extraction**: LLM call asks "What coding conventions, patterns, or preferences did the agents discover or follow?" → stores as `project/conventions/*` memories
2. **Mistake extraction**: "What mistakes were made and corrected during this run?" → stores as `project/mistakes/*`
3. **Preference extraction**: "What did the user explicitly prefer or reject?" → stores as `project/preferences/*`

Uses structured output (JSON schema) for consistent format. Costs ~1 cheap LLM call per run (~$0.01).

**Automatic pruning:** `MemoryStore.decay()` is called on startup. Entries older than 30 days with `accessCount < 2` are pruned. Entries with `confidence < 0.3` are pruned.

### Phase 3 — Memory Injection into Prompts (1-2 days)

**Modified files:**
- `server/src/swarm/DiscussionRunnerBase.ts` — inject memories into `systemPrompt`
- `server/src/swarm/blackboard/contextBuilders.ts` — inject memories into planner/worker context
- `server/src/swarm/PipelineRunner.ts` — carry memories through pipeline phases

**Implementation:**

Each runner's prompt builder calls `MemoryStore.query(directive)` to get relevant memories. They're injected as:

```
## Project Memory
- **Conventions**: [list of convention memories]
- **Past mistakes**: [list of mistake memories to avoid]
- **User preferences**: [list of preference memories]
```

This section appears after the main directive but before the agent's specific instructions. It's concise (max ~500 tokens) and tagged with `(auto-extracted from past runs)`.

### Phase 4 — Explicit Memory API + UI (2 days)

**New files:**
- `server/src/routes/memory.ts` (~80 LOC) — CRUD endpoints
- `web/src/components/MemoryPanel.tsx` (~150 LOC) — browse/manage memories

**API endpoints:**
- `GET /api/memory` — list all memories
- `POST /api/memory` — store a memory (user can add explicit "always do X" rules)
- `DELETE /api/memory/:key` — remove a memory
- `POST /api/memory/search` — semantic search

**UI:** A collapsible panel in the sidebar showing stored memories, with add/edit/delete. Memories are tagged, searchable, and show last-accessed date.

**Dependencies:** Phase 1 → Phase 2 → Phase 3 + Phase 4 (parallel).

**Risk:** Memory staleness. Mitigate with decay + pruning. Also risk of injecting contradictory memories. Mitigate with dedup (skip if `key` already exists with similar `value` via embedding similarity check).

---

## Direction 6: Observable, Debuggable Swarm Runs

**Goal:** A timeline UI where you scrub through a run, see what each agent saw/thought/wrote at each step, replay from any checkpoint, and inject human steering mid-run. Makes the swarm a tool you *collaborate* with.

### Phase 1 — Checkpoint Persistence (2-3 days)

**New files:**
- `server/src/swarm/checkpoint/RunCheckpoint.ts` (~150 LOC)
- `server/src/swarm/checkpoint/RunCheckpoint.test.ts` (~80 LOC)

**Implementation:**

```ts
interface RunCheckpoint {
  runId: string;
  phase: SwarmPhase;
  round: number;
  agentIndex: number;
  timestamp: number;
  transcriptSnapshot: TranscriptEntry[];   // up to this point
  boardState?: BoardSnapshot;                // blackboard-specific
  multiWriterProposals?: HunkProposal[];    // write-mode specific
  agentStates: Map<string, AgentState>;
  configSnapshot: Partial<RunConfig>;        // config at checkpoint time
}
```

**When to checkpoint:**
- After each agent's turn completes (discussion presets)
- After each todo claim/commit cycle (blackboard)
- Before and after each pipeline phase (pipeline)
- On user `injectUser` events

**Storage:** `<clone>/checkpoints/<runId>/checkpoint-<phase>-<round>-<agent>.json`

**Replay from checkpoint:**
- `POST /api/swarm/replay/:runId/from/:checkpointId` — reconstructs runner state from checkpoint, resumes execution
- Only works for discussion presets (blackboard state is more complex — Phase 2)
- The runner is rebuilt with the checkpoint's config, transcript is restored, and the run continues from the next agent's turn

### Phase 2 — Event Timeline API (2-3 days)

**New files:**
- `server/src/routes/timeline.ts` (~150 LOC)

**API endpoints:**
- `GET /api/timeline/:runId` — returns the full event timeline with timestamps, phase markers, and checkpoint IDs
- `GET /api/timeline/:runId/events?from=N&to=M` — paginated event slice
- `GET /api/timeline/:runId/agent/:agentId` — events filtered by agent
- `GET /api/timeline/:runId/checkpoints` — list of available checkpoints with metadata

**Response format:**
```ts
interface Timeline {
  runId: string;
  startTime: number;
  endTime?: number;
  phases: TimelinePhase[];
  agents: TimelineAgent[];
  checkpoints: TimelineCheckpoint[];
  totalEvents: number;
}

interface TimelinePhase {
  phase: SwarmPhase;
  startEventIndex: number;
  endEventIndex?: number;
  round?: number;
}
```

The timeline is built by replaying the run's event log (already persisted by `RunStatePersister`) and grouping events into phase buckets.

### Phase 3 — Timeline UI Component (3-4 days)

**New files:**
- `web/src/components/timeline/TimelineView.tsx` (~300 LOC) — main timeline component
- `web/src/components/timeline/TimelinePhase.tsx` (~80 LOC) — phase marker
- `web/src/components/timeline/TimelineAgent.tsx` (~80 LOC) — agent row
- `web/src/components/timeline/TimelineEvent.tsx` (~100 LOC) — event detail

**UI Design:**

```
┌─────────────────────────────────────────────────────────────────────┐
│ Timeline: Run abc123                                                │
│ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐           │
│ │ Seeding │ │ R1 │ │ R2 │ │ R3 │ │ Synth │ │ Critique │ │ Done │   │
│ └─────┘ └─────┘ └─────┘ └─────┘ └─────┘ └─────┘ └─────┘           │
│ Agent 1 ████████░░░░████████░░░░████████████░░░░                    │
│ Agent 2 ░░░░████████░░░░████████████░░░░████████                    │
│ Agent 3 ░░░░░░░░░░░░████░░░░████████████████████                    │
│                                                                     │
│ [Checkpoint: Round 2 start ▼] [Checkpoint: After R2 critique ▼]    │
│                                                                     │
│ ► Event: Agent 2 Round 2 Response (click to expand)                  │
│   "I've identified a security issue in the auth module..."         │
└─────────────────────────────────────────────────────────────────────┘
```

- Horizontal axis = time, vertical axis = agents
- Phase markers at top (colored bars)
- Checkpoint markers (diamond icons, clickable → "Resume from here")
- Scrub slider at bottom to zoom into a time range
- Click any event to see the agent's full input/output in a side panel

### Phase 4 — Mid-Run Steering (2-3 days)

**Modified files:**
- `server/src/services/Orchestrator.ts` — enhance `injectUser` with steering options
- `web/src/components/transcript/StreamingDock.tsx` — add steering controls

**Implementation:**

Enhance the existing `injectUser` to support structured steering:

```ts
interface SteeringCommand {
  type: "redirect" | "nudge" | "priority" | "abort_agent";
  targetAgent?: string;
  payload: string;
}

// redirect: "Change focus to X" → adjusts remaining agents' prompts
// nudge: "Consider also Y" → adds context to next agent's prompt
// priority: "This todo is now top priority" → reorders blackboard todos
// abort_agent: "Stop Agent 3's current task" → cancels that agent's turn
```

UI: A "Steer" button next to the chat input expands to show preset steering options. The command is sent as a `POST /api/swarm/steer` endpoint that wraps `injectUser` with structured metadata.

**Dependencies:** Phase 1 → Phase 2 → Phase 3, Phase 4 (independent after Phase 1).

**Risk:** Checkpoint replay fidelity — runner state (especially blackboard) is complex. Mitigate by starting with discussion-preset-only replays and adding blackboard support incrementally.

---

## Direction 7: Multi-Repo, Multi-Language

**Goal:** The swarm operates across multiple repositories and non-code tasks (docs, data pipelines, config management). Extends from a code-only tool to a general-purpose multi-agent platform.

### Phase 1 — Multi-Repo Configuration (3-4 days)

**Modified files:**
- `server/src/services/RepoService.ts` — support multiple clones
- `server/src/routes/swarm.ts` — accept array of repos
- `server/src/swarm/SwarmRunner.ts` — `RunConfig.repoUrls: string[]`

**Implementation:**

```ts
// Current: single repo
interface RunConfig {
  repoUrl?: string;
  localPath?: string;
  // ...
}

// Extended: multi-repo
interface RunConfig {
  repoUrl?: string;                    // backward compatible
  localPath?: string;                  // backward compatible
  repos?: RepoConfig[];                // NEW: multi-repo support
}

interface RepoConfig {
  url: string;                         // git URL or local path
  name: string;                        // human-readable identifier
  role: "primary" | "dependency" | "target";
  branch?: string;                     // checkout branch (default: main)
  pathMapping?: Record<string, string>; // map virtual paths to repo-relative paths
}
```

`RepoService` changes:
- `cloneAll()` — clones each repo to `<workspace>/<repo-name>/`
- `readFile(repoName, path)` — reads from the correct clone
- `writeFile(repoName, path, content)` — writes to the correct clone
- `applyHunks(repoName, hunks)` — applies to the correct clone
- Cross-repo references resolved via `pathMapping`: e.g., `api/src/auth.ts` → `{ repo: "backend", path: "src/auth.ts" }`

**Agent prompt changes:** When multiple repos are configured, each agent's prompt includes a repo map showing which repo owns which paths. The prompt says "When editing files, prefix the path with the repo name: `backend/src/auth.ts`".

### Phase 2 — Cross-Repo Task Assignment (2-3 days)

**Modified files:**
- `server/src/swarm/blackboard/plannerRunner.ts` — multi-repo planning
- `server/src/swarm/blackboard/workerRunner.ts` — multi-repo task execution

**Implementation:**

For blackboard runs across repos:
- Planner creates todos tagged with `repo: "backend"` or `repo: "frontend"`
- Workers claim todos matching their assigned repo (or all repos if not restricted)
- `applyHunks` routes to the correct repo's `RepoService`

For discussion presets:
- Each agent can edit any repo (prompt includes all repo maps)
- `reconcileHunks` is called per-repo (hunks are grouped by repo prefix)

### Phase 3 — Non-Code Task Types (3-4 days)

**New files:**
- `server/src/swarm/tasks/TaskType.ts` (~50 LOC) — task type definitions
- `server/src/swarm/tasks/DocumentTask.ts` (~150 LOC) — document generation
- `server/src/swarm/tasks/DataTask.ts` (~150 LOC) — data pipeline definition

**Implementation:**

```ts
type TaskType = "code" | "document" | "data" | "config" | "review";

interface TaskConfig {
  type: TaskType;
  outputFormat?: string;  // "markdown" | "json" | "yaml" | "csv"
  schema?: object;        // JSON schema for structured output
  reviewers?: number;      // how many review passes
}
```

For non-code tasks, the key change is **output validation instead of hunk application**:
- Instead of `applyHunks()`, validate the output against `schema`
- Instead of `writeFile()`, write to a designated output path
- The deliverable IS the output, not code diffs

**Document task:** Agents collaboratively write a document. Each agent contributes sections, a synthesizer merges. Output is a single file (markdown, JSON, etc.).

**Data task:** Agents analyze data patterns, propose pipeline steps. Output is a pipeline definition (JSON DAG of transformations).

### Phase 4 — Multi-Language Runtime Support (2-3 days)

**Modified files:**
- `server/src/services/RepoService.ts` — language-aware file operations
- `server/src/swarm/blackboard/prompts/worker.ts` — language-specific prompt sections

**Implementation:**

When a repo is configured, detect the primary language:
- `package.json` → TypeScript/JavaScript
- `Cargo.toml` → Rust
- `requirements.txt` / `pyproject.toml` → Python
- `go.mod` → Go
- Mixed repos: detect per-file based on extension

This affects:
- **Hunk format**: Python uses different indentation conventions than Rust
- **Test commands**: `npm test` vs `cargo test` vs `pytest`
- **Build commands**: `npm run build` vs `cargo build`
- **Prompt framing**: "You are editing a Python project" vs "You are editing a Rust project"

The `TaskType` and language are injected into system prompts automatically based on repo detection. No manual configuration needed.

**Dependencies:** Phase 1 → Phase 2 + Phase 3 (parallel) → Phase 4.

**Risk:** Cross-repo hunk conflicts (a hunk that spans repos). Mitigate by requiring repo-scoped hunks. Also risk of repo authentication for private repos — mitigate by using existing git credentials on the host machine.

---

## Cross-Direction Dependencies

```
Direction 1 (Self-improving) ─────────────────────┐
                                                    │
Direction 2 (Hierarchical) ──────────┐              │
                                      │              │
Direction 3 (Stream merge) ───────────┤              │
                                      │              │
Direction 4 (Task decomposition) ─────┤ ─── needs 2 │
                                      │              │
Direction 5 (Persistent memory) ──────┤              │
                                      │              │
Direction 6 (Observable) ────────────┤ ─── needs 1  │
                                      │              │
Direction 7 (Multi-repo) ─────────────┘              │
                                    needs 1 ──────────┘
```

**Recommended implementation order:**
1. **Direction 1 (Phase 1-2)** — Outcome scoring + history. Every other direction benefits from knowing what works.
2. **Direction 6 (Phase 1-3)** — Checkpoints + timeline. Makes debugging and development of all other directions easier.
3. **Direction 2 (Phase 1-2)** — Sub-run protocol enables both hierarchical swarms and task decomposition.
4. **Direction 5 (Phase 1-3)** — Persistent memory. High value, relatively self-contained.
5. **Direction 4 (Phase 1-3)** — Task decomposition. Depends on Direction 2.
6. **Direction 3 (Phase 1-3)** — Streaming merge. Hardest technically, can build incrementally.
7. **Direction 7 (Phase 1-2)** — Multi-repo. Most infra work, least urgency for single-repo users.

**Total estimated effort:** ~60-70 person-days for all 7 directions. Approximately 3-4 months for a single developer, 6-8 weeks with focused pair work.