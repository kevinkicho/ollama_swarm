# Swarm Pattern Combination — Implementation Plans

Seven concrete features that combine swarm patterns. Ordered by expected impact.

---

## Plan 1: Debate-Judge as Blackboard's Auditor

**Goal:** Replace Blackboard's single-agent auditor pass with a 2-round debate (PRO/CON/JUDGE) where PRO argues "criteria met", CON argues "criteria not met", and JUDGE issues a structured verdict with confidence. Adversarial pressure catches gaps that single-reviewer audits miss.

### Files to Create

- `server/src/swarm/blackboard/debateAuditor.ts` (~120 lines)

### Files to Modify

- `server/src/swarm/blackboard/auditorRunner.ts` (add `debateAudit` mode)
- `server/src/swarm/blackboard/BlackboardRunner.ts` (wire debate audit into audit cycle)
- `server/src/swarm/SwarmRunner.ts` (add `debateAudit: boolean` to `RunConfig`)

### Interface

```typescript
// In debateAuditor.ts
export interface DebateAuditResult {
  verdict: ParsedDebateVerdict;  // winner, confidence, nextAction
  proEvidence: string;           // PRO's strongest points
  conEvidence: string;           // CON's weakest-point catches
  roundsUsed: number;             // 1 normally, 2 if confidence=low
}

export async function runDebateAudit(args: {
  pro: Agent;
  con: Agent;
  judge: Agent;
  criterion: ExitCriterion;      // the criterion being audited
  workTranscript: readonly TranscriptEntry[];  // recent agent entries
  userDirective?: string;
  runDiscussionAgent: RunDiscussionAgentFn;
  manager: AgentManager;
  appendSystem: (text: string) => void;
}): Promise<DebateAuditResult>
```

### Implementation Steps

1. **Create `debateAuditor.ts`** with `runDebateAudit` that:
   - Builds a PRO prompt: "Argue that this criterion IS met. Cite specific code changes."
   - Builds a CON prompt: "Argue that this criterion IS NOT met. Find gaps."
   - Runs 1-2 rounds depending on confidence (early-stop on `confidence === "high"`)
   - Runs JUDGE turn → parses `ParsedDebateVerdict`
   - Returns `DebateAuditResult`

2. **Modify `auditorRunner.ts`** `runAuditor()`:
   - Check `ctx.getActive()?.debateAudit`
   - If true: allocate 2 extra agents for PRO/CON, call `runDebateAudit()`
   - If false: existing single-agent audit (unchanged)
   - Map `DebateAuditResult.verdict.confidence` → `met`/`not-met`/`partial`

3. **Modify `BlackboardRunner.ts`**:
   - In the audit cycle, when `debateAudit` is enabled, pass `pro` and `con` agents from the pool
   - The planner agent serves as JUDGE (index 1)
   - Log debate rounds in transcript with `summary.kind: "debate_verdict"` tags

4. **Modify `SwarmRunner.ts`**:
   - Add `debateAudit?: boolean` to `RunConfig` (default `false`)
   - Add `debateAuditRounds?: number` (default `1`, max `2`)

### Risks
- Extra latency: 2-3 agent turns per criterion vs. 1 today. Mitigated by early-stop on `confidence === "high"`.
- Agent pool size: needs 2 extra agents. The planner (index 1) serves as JUDGE, so only 2 additional are needed.

---

## Plan 2: Council Inside Map-Reduce Mappers (diversity × breadth)

**Goal:** Replace each mapper's single-shot prompt with a 3-round council (draft → reveal → revise) so the reducer gets richer, more vetted inputs.

### Files to Create

- `server/src/swarm/mapReduceCouncilMapper.ts` (~80 lines)

### Files to Modify

- `server/src/swarm/MapReduceRunner.ts` (add `councilMapperMode` branch)
- `server/src/swarm/mapReducePromptHelpers.ts` (add `buildCouncilMapperSynthesisPrompt`)
- `server/src/swarm/SwarmRunner.ts` (add `councilMappers: boolean` to `RunConfig`)

### Interface

```typescript
// In mapReduceCouncilMapper.ts
export interface CouncilMapperResult {
  synthesis: string;         // the council-agreed synthesis for this slice
  drafts: string[];           // each agent's independent draft
  convergence: "high" | "medium" | "low";
}

export async function runCouncilMapperSlice(args: {
  agents: Agent[];            // 2-3 agents for this slice
  slice: readonly string[];   // file paths for this mapper
  seedSnapshot: readonly TranscriptEntry[];
  userDirective?: string;
  runDiscussionAgent: RunDiscussionAgentFn;
  manager: AgentManager;
  appendSystem: (text: string) => void;
}): Promise<CouncilMapperResult>
```

### Implementation Steps

1. **Create `mapReduceCouncilMapper.ts`**:
   - Round 1: Each agent drafts independently (only sees seed + slice files)
   - Round 2: Each agent sees all drafts, revises their position
   - Round 3 (optional, if convergence !== "high"): One agent synthesizes into a unified finding
   - Use `parseConvergenceSignalLoose()` to detect convergence

2. **Modify `MapReduceRunner.ts`**:
   - In `runStreamingMapReduce()`, if `cfg.councilMappers` is set:
     - Allocate `cfg.agentCount - 1` mappers as before, but each "mapper" is now a 2-3 agent council
     - Total agents = 1 reducer + (agentCount - 1) × councilSize
     - After each council converges, the synthesis becomes the "mapper output" fed to the reducer
   - In `loop()`, add `mapperCouncilSize` calculation and agent allocation

3. **Modify `mapReducePromptHelpers.ts`**:
   - Add `buildCouncilMapperSynthesisPrompt()` that asks one agent to synthesize the council's drafts
   - Add `buildCouncilMapperDraftPrompt()` that shows the slice + seed context

4. **Modify `SwarmRunner.ts`**:
   - Add `councilMappers?: boolean` to `RunConfig`
   - Add `councilMapperRounds?: number` (default 2, max 3)

### Risks
- Runtime scales linearly with council rounds (2-3 mapper prompts per slice vs. 1). Mitigated by short round budgets and early-stop.
- Agent count increases: if `councilMapperRounds = 3` and `agentCount = 4`, you need 1 reducer + 3×3 = 9 mapper agents = 10 total. Document this.

---

## Plan 3: Pheromone Heatmap Service (universal file-attention signal)

**Goal:** Extract stigmergy's pheromone ranking into a standalone service that any preset can query to get "hot files" — files that accumulated the most visits/interest/confidence during a prior or concurrent stigmergy run.

### Files to Create

- `server/src/swarm/pheromoneHeatmap.ts` (~100 lines)

### Files to Modify

- `server/src/swarm/StigmergyRunner.ts` (write pheromones to heatmap on each `applyAnnotation`)
- `server/src/swarm/blackboard/workerRunner.ts` (read heatmap to bias file selection)
- `server/src/swarm/blackboard/contextBuilders.ts` (pass heatmap into WorkerContext)
- `server/src/swarm/blackboard/prompts/worker.ts` (include hot files in worker prompt)
- `server/src/swarm/SwarmRunner.ts` (add `pheromoneHotseed?: string` to `RunConfig` — ID of a prior run whose heatmap to seed from)

### Interface

```typescript
// In pheromoneHeatmap.ts
export interface FileHeat {
  path: string;
  score: number;        // decay-weighted: visits × avgInterest × (avgConfidence/10) × decay^roundsSince
  visits: number;
  avgInterest: number;
  avgConfidence: number;
}

export class PheromoneHeatmap {
  private annotations = new Map<string, AnnotationState>();
  private currentRound: number;

  updateFromAnnotations(annotations: ReadonlyMap<string, AnnotationState>, round: number): void;
  topFiles(n: number): FileHeat[];
  toSnapshot(): Record<string, AnnotationState>;
  fromSnapshot(data: Record<string, AnnotationState>): void;
  clear(): void;
}

// Singleton per run
export const pheromoneHeatmap = new PheromoneHeatmap();
```

### Implementation Steps

1. **Create `pheromoneHeatmap.ts`**:
   - `PheromoneHeatmap` class with `updateFromAnnotations()`, `topFiles(n)`, `toSnapshot()`, `fromSnapshot()`, `clear()`
   - Uses `rankingScore()` from `stigmergyPromptHelpers.ts` for scoring
   - Singleton exported instance

2. **Modify `StigmergyRunner.ts`**:
   - After each `applyAnnotation()`, call `pheromoneHeatmap.updateFromAnnotations(this.annotations, this.round)`
   - This populates the heatmap for concurrent or subsequent runs

3. **Modify `workerRunner.ts`** / `contextBuilders.ts`:
   - Add `getPheromoneHeatmap(): PheromoneHeatmap | undefined` to `WorkerContext`
   - When `stigmergyOnBlackboard` or `pheromoneHotseed` is set, the worker prompt includes top-10 hot files
   - Workers prioritize todos matching hot files

4. **Modify `prompts/worker.ts`**:
   - Add a `## Hot Files` section to the worker prompt when heatmap has data:
     ```
     ## Hot Files (from prior exploration)
     The following files were identified as most relevant by a prior exploration pass:
     1. src/auth/login.ts (score: 8.7, interest: 9, confidence: 9)
     2. src/utils/jwt.ts (score: 6.2, interest: 7, confidence: 8)
     ...
     ```

5. **Modify `SwarmRunner.ts`**:
   - Add `pheromoneHotseed?: string` (run ID to load heatmap from)
   - Add `pheromoneHotFiles?: string[]` (explicit file list, alternative to hotseed)

### Risks
- Staleness: pheromones from a prior run may reference files that changed. Mitigated by the heatmap reporting `lastVisitedRound` — workers can re-verify.
- Cross-pollination: a "hot file" from an unrelated domain could mislead. Mitigated by showing the score so workers can discount low-confidence entries.

---

## Plan 4: Pipeline Preset (Explore → Decompose → Validate)

**Goal:** String 3 sub-runs together as a single preset. Each phase's transcript + deliverable feeds the next phase's seed.

### Files to Create

- `server/src/swarm/PipelineRunner.ts` (~200 lines)
- `server/src/swarm/pipelinePhases.ts` (~80 lines)

### Files to Modify

- `server/src/swarm/SwarmRunner.ts` (add `"pipeline"` to `PresetId`, add pipeline config fields)
- `server/src/web/src/components/SetupForm.tsx` (add pipeline preset to the form)

### Interface

```typescript
// In pipelinePhases.ts
export interface PipelinePhase {
  preset: PresetId;
  rounds?: number;           // override the phase's default rounds
  agentCount?: number;       // override the phase's default agent count
  model?: string;            // override model for this phase
}

// In SwarmRunner.ts
export interface PipelineConfig {
  phases: PipelinePhase[];
  /** How to pipe the previous phase's output into the next:
   *  "transcript" — inject last N transcript entries as seed context
   *  "deliverable" — inject deliverable.md content as directive
   *  "both" — transcript + deliverable
   */
  pipeMode?: "transcript" | "deliverable" | "both";
  /** Max transcript entries to pipe forward (default 20) */
  pipeMaxEntries?: number;
}

// Extend RunConfig
declare interface RunConfig {
  // ... existing ...
  pipeline?: PipelineConfig;
}
```

### Implementation Steps

1. **Create `pipelinePhases.ts`** with types above.

2. **Create `PipelineRunner.ts`**:
   ```typescript
   export class PipelineRunner implements SwarmRunner {
     private phases: { runner: SwarmRunner; config: RunConfig }[] = [];
     
     async start(cfg: RunConfig): Promise<void> {
       const pipeline = cfg.pipeline!;
       let previousTranscript: TranscriptEntry[] = [];
       let previousDeliverable: string | undefined;
       
       for (let i = 0; i < pipeline.phases.length; i++) {
         const phase = pipeline.phases[i];
         const phaseConfig: RunConfig = {
           ...cfg,
           preset: phase.preset,
           rounds: phase.rounds ?? cfg.rounds,
           agentCount: phase.agentCount ?? cfg.agentCount,
           model: phase.model ?? cfg.model,
           // Pipe previous phase output into directive/seed
           userDirective: buildPipedDirective(cfg.userDirective, previousTranscript, previousDeliverable, pipeline.pipeMode),
         };
         
         const runner = createRunner(phaseConfig);
         await runner.start(phaseConfig);
         
         // Capture output for next phase
         const status = runner.status();
         previousTranscript = status.transcript;
         previousDeliverable = await readDeliverable(phaseConfig);
       }
     }
   }
   ```
   - `buildPipedDirective()` appends "## Prior Phase Output" section to the userDirective
   - `readDeliverable()` reads the `deliverable.md` file from the clone path
   - `createRunner()` is the existing factory that maps `PresetId` → runner instance

3. **Modify `SwarmRunner.ts`**:
   - Add `"pipeline"` to `PresetId` type union
   - Add `pipeline?: PipelineConfig` to `RunConfig`

4. **Modify `SetupForm.tsx`**:
   - Add "pipeline" preset option with a phase configurator UI
   - Default pipeline: `[{ preset: "stigmergy", rounds: 2 }, { preset: "orchestrator-worker", rounds: 4 }, { preset: "debate-judge", rounds: 1 }]`

### Risks
- Cumulative context: piping entire transcripts forward grows the prompt. Mitigated by `pipeMaxEntries` (default 20) and `pipeMode: "deliverable"` which only sends the structured output.
- Phase failure: if phase 2 crashes, phase 3 doesn't start. Mitigated by making each phase a best-effort attempt and continuing regardless.
- Runtime: 3 phases × N rounds = long total runtime. Document clear time estimates.

---

## Plan 5: Post-Round Critique Hook (any preset)

**Goal:** After each discussion round, one designated agent reviews the round's entries and writes a critique. The critique becomes a system message for the next round. Costs 1 extra prompt per round.

### Files to Create

- `server/src/swarm/postRoundCritique.ts` (~60 lines)

### Files to Modify

- `server/src/swarm/DiscussionRunnerBase.ts` (add `postRoundCritique` option)
- `server/src/swarm/SwarmRunner.ts` (add `postRoundCritique?: boolean` to `RunConfig`)
- Each discussion runner's loop method (call `maybeRunPostRoundCritique` after each round)

### Interface

```typescript
// In postRoundCritique.ts
export async function maybeRunPostRoundCritique(args: {
  agents: Agent[];
  round: number;
  totalRounds: number;
  transcript: readonly TranscriptEntry[];
  userDirective?: string;
  enabled: boolean;
  runDiscussionAgent: RunDiscussionAgentFn;
  stats: AgentStatsCollector;
  appendSystem: (text: string) => void;
  presetName: string;
}): Promise<void>
```

### Implementation Steps

1. **Create `postRoundCritique.ts`**:
   - `maybeRunPostRoundCritique()`: if `enabled` and `round > 1`:
     - Pick agent with lowest turn count (ensures round-robin critique distribution)
     - Build prompt: "You are the CRITIC this round. Review the last round's entries. What's missing? What's wrong? What should the team focus on next?"
     - Call `runDiscussionAgent()` with `agentName: "swarm-read"`
     - Append system message: `[Round ${round} Critique] ${critique}`
   - Skip round 1 (nothing to critique yet)

2. **Modify `DiscussionRunnerBase.ts`**:
   - No code changes needed — the hook is called by each runner's loop method

3. **Modify each runner's loop** (7 runners):
   - After each round completes, call `maybeRunPostRoundCritique({ ... enabled: cfg.postRoundCritique ?? false })`
   - This is 3-5 lines per runner

4. **Modify `SwarmRunner.ts`**:
   - Add `postRoundCritique?: boolean` to `RunConfig`

### Risks
- Latency: 1 extra prompt per round (N rounds → N-1 extra prompts). Mitigated by using the fastest/cheapest agent.
- Noise: critiques may be low-quality. Mitigated by the prompt framing ("what should the team focus on" rather than "critique everything").

---

## Plan 6: Round-Robin Dispositions Inside Blackboard Workers

**Goal:** Give blackboard workers rotating dispositions (critic/synthesizer/gap-finder/builder) across cycles so the same worker approaches todos from different angles.

### Files to Modify

- `server/src/swarm/blackboard/prompts/worker.ts` (add disposition framing)
- `server/src/swarm/blackboard/workerRunner.ts` (track per-worker cycle count, pick disposition)
- `server/src/swarm/SwarmRunner.ts` (add `workerDispositions?: boolean` to `RunConfig`)

### Implementation Steps

1. **Modify `workerRunner.ts`**:
   - Add `dispositionCycle: Map<string, number>` to track per-worker cycle count
   - Before each worker turn, if `cfg.workerDispositions`:
     - `cycle = dispositionCycle.get(agent.id) ?? 0`
     - `disposition = getDispositionForTurn(cycle)` (imported from `roundRobinPromptHelpers.ts`)
     - Prepend disposition framing to the worker prompt: `"This cycle, take the **${disposition.name}** disposition: ${disposition.framing}"`
     - After the turn, increment `dispositionCycle`

2. **Modify `prompts/worker.ts`**:
   - Add optional `disposition?: RoundRobinDisposition` parameter to `buildWorkerUserPrompt()`
   - If disposition is set, add a section: `"**${disposition.name.toUpperCase()} DISPOSITION THIS CYCLE:** ${disposition.framing}"`

3. **Modify `SwarmRunner.ts`**:
   - Add `workerDispositions?: boolean` to `RunConfig`

### Risks
- Workers might produce lower-quality code when forced into a "critic" disposition (critics point out gaps but don't implement). Mitigated by only allowing implementation-focused dispositions (builder, synthesizer) for workers with write tools.
- Could conflict with the worker's existing role guidance. Mitigated by making disposition framing secondary to the primary role.

---

## Plan 7: MoA Self-Critique as Post-Synthesis Hook

**Goal:** After any preset produces a synthesis (council consensus, OW lead plan, map-reduce reducer), run the synthesis through MoA's self-critique step to revise and strengthen it.

### Files to Create

- `server/src/swarm/postSynthesisCritique.ts` (~70 lines)

### Files to Modify

- `server/src/swarm/CouncilRunner.ts` (add optional critique after synthesis)
- `server/src/swarm/OrchestratorWorkerRunner.ts` (add optional critique after lead plan)
- `server/src/swarm/MapReduceRunner.ts` (add optional critique after reducer synthesis)
- `server/src/swarm/SwarmRunner.ts` (add `postSynthesisCritique?: boolean` to `RunConfig`)

### Interface

```typescript
// In postSynthesisCritique.ts
export interface PostSynthesisCritiqueArgs {
  synthesis: string;
  proposals: ReadonlyArray<{ workerId: string; text: string }>;
  criticAgent: Agent;
  manager: AgentManager;
  appendSystem: (text: string) => void;
  stopping: boolean;
  runDiscussionAgent: RunDiscussionAgentFn;
  stats: AgentStatsCollector;
}

export async function runPostSynthesisCritique(
  args: PostSynthesisCritiqueArgs
): Promise<string>  // returns revised synthesis (or original if critique fails)
```

### Implementation Steps

1. **Create `postSynthesisCritique.ts`**:
   - Import `runAggregatorSelfCritique` from `moaAggregation.ts`
   - `runPostSynthesisCritique()` wraps it with:
     - Build the critique prompt using the synthesis + proposals
     - Call the critic agent via `runDiscussionAgent`
     - If the revised text is substantive (>50 chars, different from original), return it
     - Otherwise, return the original synthesis
   - Log: `[Post-synthesis critique] Synthesis revised by critic agent-${criticAgent.index}.`

2. **Modify `CouncilRunner.ts`**:
   - In `runSynthesisPass()`, after getting the synthesis text, if `cfg.postSynthesisCritique`:
     - Call `runPostSynthesisCritique({ synthesis, proposals: [...recentAgentEntries], ... })`
     - Replace the synthesis text with the revised version

3. **Modify `OrchestratorWorkerRunner.ts`**:
   - After the lead's plan is parsed, optionally critique it before distributing to workers
   - The critique catches unrealistic timelines, missing edge cases, etc.

4. **Modify `MapReduceRunner.ts`**:
   - After the reducer's synthesis, optionally critique it

5. **Modify `SwarmRunner.ts`**:
   - Add `postSynthesisCritique?: boolean` to `RunConfig`

### Risks
- Extra prompt per synthesis pass (1 additional call). But it's optional and off by default.
- Critic may not improve the synthesis. The self-critique pattern in MoA shows ~60% of revisions are accepted as better. Worth it for high-stakes directives.

---

## Shared Infrastructure Needed

All 7 plans share a need for:

1. **`createRunner()` factory** in `SwarmRunner.ts` — currently a `switch/case` on `PresetId`. Add entries for new combined presets.

2. **`RunConfig` extension** — each plan adds optional fields. Since `RunConfig` already has ~100 preset-specific fields that are silently ignored by other presets, this is the established pattern.

3. **`DiscussionRunnerBase.runDiscussionAgent()`** — the new shared method for running an agent prompt+record cycle. Plans 1, 2, 5, 6, 7 all call this.

4. **`SwarmEvent` extensions** — new event types for cross-pattern signals:
   - `debate_audit_result` (Plan 1)
   - `council_mapper_result` (Plan 2)
   - `pheromone_heatmap_update` (Plan 3)
   - `pipeline_phase_start` / `pipeline_phase_end` (Plan 4)
   - `post_round_critique` (Plan 5)
   - `disposition_assigned` (Plan 6)
   - `synthesis_critique` (Plan 7)

5. **UI changes** in `SetupForm.tsx` — toggles/inputs for each feature. Each plan should add its own section under "Advanced".

---

## Recommended Implementation Order

| Order | Plan | Impact | Effort | Dependency |
|-------|------|--------|--------|------------|
| 1 | Plan 5: Post-Round Critique | Medium (all presets) | Low (~60 lines new) | None |
| 2 | Plan 7: Post-Synthesis Critique | Medium (3 presets) | Low (~70 lines new) | None |
| 3 | Plan 6: RR Dispositions in Workers | Medium (blackboard) | Low (~40 lines change) | None |
| 4 | Plan 1: Debate-Judge Auditor | High (blackboard quality) | Medium (~120 lines new) | Plan 5 or standalone |
| 5 | Plan 2: Council Mappers | High (map-reduce quality) | Medium (~80 lines new) | Plan 5 (optional) |
| 6 | Plan 3: Pheromone Heatmap | High (cross-preset attention) | Medium (~100 lines new) | None |
| 7 | Plan 4: Pipeline Preset | Highest (full combination) | High (~200 lines new) | Plans 1-3 (recommended) |