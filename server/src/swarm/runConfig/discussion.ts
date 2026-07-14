// Partial RunConfig fields — RunConfigDiscussion
export interface RunConfigDiscussion {
  /**
   * Post-synthesis critique: runs a critic agent after any synthesis
   * pass (council consensus, OW lead plan, map-reduce reducer) to
   * find gaps and produce a revised synthesis. Uses the MoA
   * self-critique pattern adapted for general use. Default false
   * (opt-in).
   */
  postSynthesisCritique?: boolean;
  /**
   * Post-round critique hook: after each discussion round, pick the
   * agent with the fewest turns and prompt it to critique the recent
   * entries. The critique is appended as a system message visible to
   * all agents next round. Costs 1 extra prompt per round. Default
   * false.
   */
  postRoundCritique?: boolean;
  /**
   * #93 deeper (2026-05-01): MoA aggregator count. When > 1, K
   * aggregators each synthesize independently in parallel, and the
   * runner picks the "most central" synthesis (highest mean Jaccard
   * with the others). Capped at 3. Default 1 (single aggregator).
   * MoA-only — other presets ignore this.
   */
  moaAggregatorCount?: number;
  /**
   * #93 deeper (2026-05-01): MoA convergence threshold. After each
   * round, if round-N synthesis has Jaccard similarity ≥ this with
   * round-(N-1) synthesis, declare convergence and stop early.
   * Range [0, 1]. Default 0.7 (empirically settles for agreed-upon
   * topics). Set to 1 to disable convergence (always run all rounds).
   * MoA-only.
   */
  moaConvergenceThreshold?: number;
  /**
   * T197 (2026-05-04): map-reduce smart slicing by import graph.
   * When true, the runner builds a TS/JS import graph + clusters
   * files by connected component so each mapper sees coherent
   * code (a→b→c stays together). Falls back to round-robin slicing
   * when:
   *   - import-graph build fails
   *   - resulting clusters too lopsided (one cluster > 70% of files)
   *   - too few TS/JS files (< 2× mapper count)
   *
   * First-cut: TS/JS only via regex extraction. Cross-language
   * (Python/Rust/Go) deferred to future ts-morph or babel substrate.
   * Default off; opt in for TS-heavy repos.
   * Map-reduce only.
   */
  importGraphSlicing?: boolean;
  /**
   * T197 (2026-05-04): stigmergy cross-cluster discovery via import graph.
   * When true, the stigmergy runner builds the import graph at run
   * start. When an explorer surfaces a high-interest annotation
   * (interest >= 7), the runner plants soft pheromone bumps on
   * related files (1-hop importers + importees) so peer explorers
   * naturally gravitate toward the affected code structure rather
   * than wandering randomly.
   *
   * Same TS/JS-only first-cut as importGraphSlicing. Default off.
   * Stigmergy only.
   */
  crossClusterDiscovery?: boolean;
  /**
   * T198 (2026-05-04) HEAVY FIRST-CUTS — opt-in flags for items that
   * need substantial follow-up work for full production quality.
   * Each shipped as a functional thin-cut + clear caveat in the
   * relevant runner. Polish deferred to focused future sessions.
   */
  /** T198a: map-reduce streaming reducer. When true, the reducer
   *  fires AT HALF-BATCH (after ceil(mapperCount/2) mappers return)
   *  in addition to its normal full-batch turn. Cuts wall-clock when
   *  one mapper is slow; produces 2 reducer turns per cycle.
   *  First-cut: doesn't actually stream chunk-by-chunk; just splits
   *  the wait into two synchronous batches. Map-reduce only. */
  streamingReducer?: boolean;
  /** T198b: role-diff dynamic role catalog. When true, the runner
   *  scans the directive for keywords + augments the BUILD_ROLES
   *  catalog with directive-specific specialist roles (auth →
   *  +Auth, performance → +Profiling, security → +Crypto, etc.).
   *  First-cut: keyword-table mapping, NOT LLM-driven role picking.
   *  Deferred-real: planner emits role catalog as JSON. Role-diff only. */
  dynamicRoles?: boolean;
  /** T198d: debate-judge parallel proposition derivation. When true,
   *  the judge generates 3 CANDIDATE propositions before debate
   *  starts + picks the most informative ONE. Only one debate runs
   *  (not 3 parallel). First-cut: sequential candidate generation
   *  + judge pick; full parallel (3 debates) deferred. Debate-judge only. */
  parallelPropositions?: boolean;
  /** T-Item-2 (2026-05-04): debate-judge K parallel debate streams.
   *  When >1, K full debates run in parallel — each stream gets its
   *  own proposition (derived in parallel via the same path that
   *  T199 parallelPropositions uses) + scoped transcript. After all
   *  streams settle, the JUDGE runs ONE cross-stream synthesis prompt
   *  to pick the most informative verdict. PRO + CON agents are
   *  REUSED across streams (each prompt is fully self-contained).
   *  Caps at 3 (each stream is ~3× cost). Debate-judge only. */
  parallelDebateStreams?: number;
  /** T198e: MoA two-stage aggregation. When true + moaAggregatorCount
   *  >= 2, after the K parallel aggregators run, one MORE TOP
   *  aggregator synthesizes the K mid-syntheses. Adds 1 round-trip
   *  but matches the original Together AI MoA two-layer shape.
   *  First-cut: cfg.moaAggregatorModel reused for the top aggregator
   *  (no separate cfg.moaTopAggregatorModel field — could add later).
   *  MoA only. */
  twoStageMoA?: boolean;
  /**
   * T199 (2026-05-04): N-level MoA aggregation tree. Generalizes
   * twoStageMoA to multiple aggregator layers. Each level halves
   * the input set (rounded up): K proposers → ceil(K/2) L1-aggs
   * → ceil(K/4) L2-aggs → ... → 1 top-agg. Cap at 4 levels for
   * runtime sanity.
   *
   * When set, supersedes twoStageMoA (always runs at least 2 levels).
   * Default 1 = just K parallel aggregators + winner-pick (pre-T199).
   * 2 = today's two-stage. 3+ = multi-tier tree.
   *
   * MoA only.
   */
  moaAggregationLevels?: number;
  /** T198f: OW-Deep bi-directional refinement. When true, mid-lead's
   *  plan prompt allows them to emit `PUSHBACK: <issue>` instead of
   *  normal assignments. Runner logs the pushback + still proceeds
   *  with what was emitted (or skips dispatch if pushback only).
   *  First-cut: pushback is informational; no auto-replan triggered
   *  on the orchestrator. OW-Deep only. */
  bidirectionalRefinement?: boolean;
  /** T198g: baseline multi-attempt. Number of SEQUENTIAL attempts to
   *  run; pick the one with the most hunks applied. Default 1.
   *  First-cut: sequential, not parallel (parallel would need a
   *  parallel-runner harness — deferred). Caps at 5. Baseline only. */
  baselineAttempts?: number;
  /** Q4 (2026-05-04): best-of-N at the turn level. When set, the
   *  runner fires K samples for high-stakes turns + a judge picks
   *  (length heuristic when no judge available). Generalizes T199's
   *  self-consistency-on-hunks pattern. K cap = 5 (matching the
   *  existing self-consistency cap). Default 1 (no fan-out). Honored
   *  Library ready (`bestOfNTurn.ts`); not yet adopted by a runner. */
  bestOfNTurn?: number;
  /** Q6 (2026-05-04): dynamic role picker for round-robin / role-diff.
   *  When set, the runner consults a planner-tier meta-prompt to pick
   *  the next role based on what the conversation NEEDS (vs fixed
   *  cycle). One extra prompt per turn. Default OFF — fixed-cycle
   *  rotation preserves the legacy deterministic behavior. Library
   *  ready (`dynamicRolePicker.ts`); not yet adopted by RR/role-diff. */
  dynamicRolePicker?: boolean;
  /** Q7 (2026-05-04): debate-judge swap-sides bias check. After the
   *  judge's verdict, run a SECOND verdict pass with PRO/CON labels
   *  swapped. If the same SIDE wins both times, the verdict was
   *  driven by labeling (judge bias) — flag low confidence + skip
   *  the post-verdict build phase. Default OFF — adds 1 judge call
   *  per debate. **Wired** in `debateStreams.runJudgeTurn`. */
  swapSidesBiasCheck?: boolean;
  /** Q5 (2026-05-04): dissent preservation in synthesis. When set,
   *  council synthesizer prompts emit THREE sections
   *  (majority view + minority report + open questions) instead of
   *  one consolidated answer. Stops "polite convergence" from
   *  averaging away the most informative contrarian insight.
   *  Default OFF — longer output. **Wired** in `councilSynthesis`. */
  preserveDissent?: boolean;
  /** Q8 (2026-05-04): stigmergy pheromone decay + saturation cap.
   *  When set, explorer prompts filter saturated files and surface a
   *  decay-ranked pick hint. Default OFF. **Wired** in
   *  `stigmergyTurns.runExplorerTurn` (rankingScore already applies
   *  baseline decay always). */
  pheromoneDecay?: boolean;
  /** Q9 (2026-05-04): map-reduce mid-cycle finding broadcast. When set,
   *  mappers run sequentially and high-confidence findings from earlier
   *  mappers are injected into later mappers' prompts this cycle.
   *  Default OFF. **Wired** in `mapReduceLoopBody` (non-streaming path). */
  midCycleBroadcast?: boolean;
  /** Q12 (2026-05-04): best-preset auto-pick router. When set, the
   *  /api/swarm/start route consults `presetRouter.ts` to pick the
   *  best preset given the user directive (overriding the explicit
   *  cfg.preset only when the heuristic OR LLM router disagrees with
   *  high confidence). Wrong picks erode trust — keep cfg.preset
   *  override authoritative; route is advisory. Default OFF.
   *  Cross-cutting (orchestrator-level, not per-preset). */
  presetRouter?: boolean;
  /** Q13 (2026-05-04): per-preset rubric grading. When set, after the
   *  run completes a judge model scores the run output against a
   *  task-specific rubric (correctness / completeness / specificity /
   *  actionability / format + per-preset extras). Surfaces "preset X
   *  scored 7/10 on correctness but 3/10 on completeness" so users
   *  know which dimension to retry. +1 judge call per run. Default
   *  OFF. Honored via the shared `rubricGrading.ts` helpers. */
  rubricGrading?: boolean;
  /** Direction 6: per-actor-turn checkpoint persistence. When set,
   *  a checkpoint is written to <clone>/.swarm-checkpoints/<runId>/
   *  after each agent's turn completes. Enables timeline scrubbing
   *  and replay-from-checkpoint. Default OFF — adds one disk write
   *  per agent turn. Honored by DiscussionRunnerBase (all 8 discussion
   *  presets); blackboard deferred. */
  checkpointing?: boolean;
  /** Q3 (2026-05-04): inter-agent @-mention contracts. When set, the
   *  runner extracts ```mention``` envelopes from agent output +
   *  surfaces them in the targeted agent's next prompt as "Pending
   *  contracts you have to address". Per-pair cooldown
   *  (MENTION_COOLDOWN_TURNS=3) prevents A→B→A loops. Default OFF —
   *  adds prompt-shape complexity. Honored by all multi-agent
   *  presets via the shared `agentMentionContract.ts` helper. */
  mentionContracts?: boolean;
  /** Q1 (2026-05-04): self-critique pass. When set, the runner sends
   *  high-stakes turns BACK to the same agent with a critique prompt
   *  before shipping. Verdict + refined output replace the original
   *  when the model flags issues. Default OFF (doubles per-turn
   *  latency). **Wired** on DebateJudge judge turn
   *  (`debateStreams.runJudgeTurn`). Other runners can adopt via
   *  `selfCritique.ts` helpers. */
  selfCritique?: boolean;
  /**
   * Council: shared research standup each cycle (all agents web-scan, notes
   * merged into progressContext). Default **false** — independent per-worker
   * literature research only. Opt in when you want a collective scan.
   */
  councilSharedResearch?: boolean;
  /** T-Item-CouncilRec (2026-05-04): council reconcile policy.
   *  Picks how the council settles on a final answer:
   *  - "revise" (default): existing behavior — agents see peer drafts
   *    starting Round 2 and revise; lead synthesizes at end.
   *  - "vote": after discussion, each drafter casts ONE vote for the
   *    BEST OTHER draft (no self-votes). Most-voted draft wins; lead
   *    presents the winner. **Wired** in `councilSynthesis`.
   *  - "judge": synthesis uses `buildJudgePickPrompt` — lead PICKS ONE
   *    draft as canonical (not merge). **Wired** in `councilSynthesis`.
   *  Each policy is opt-in; default keeps the legacy revise+merge flow.
   *  Council only. */
  councilReconcile?: "revise" | "vote" | "judge";
  /** T-Item-MapPart (2026-05-04): map-reduce partition strategy.
   *  Selects how the runner splits work across mappers:
   *  - "round-robin" (default): evenly distribute top-level entries
   *    by mapperIndex % K.
   *  - "size-balanced": weight top-level entries by their recursive
   *    file count + greedily assign to the lightest-loaded mapper.
   *    Avoids one mapper getting `node_modules` while another gets
   *    a single README. Recommended for repos with one or two
   *    dominant directories.
   *  - "import-graph": already shipped via `cfg.importGraphSlicing`
   *    (the new field is the unified replacement). When this field
   *    is set to "import-graph", `cfg.importGraphSlicing` semantics
   *    are used. Map-reduce only. */
  mapReducePartition?: "round-robin" | "size-balanced" | "import-graph";
  /** Plan 2: council inside map-reduce mappers. When true, each mapper
   *  slice is processed by a 2-3 agent council (draft → revise) instead
   *  of a single-shot prompt. The council's synthesis becomes the mapper
   *  output fed to the reducer. Produces richer, more vetted inputs at
   *  the cost of more agent calls per slice. Map-reduce only. */
  councilMappers?: boolean;
  /** Number of council rounds for council mappers (default 2, max 3).
   *  Round 1 = draft, Round 2 = revise, Round 3 (optional) = refine.
   *  Map-reduce only; ignored when councilMappers is false. */
  councilMapperRounds?: number;
  /** T-Item-MoaTools (2026-05-04): MoA proposer tool access. When true,
   *  proposers (layer-1 agents) get read-only tool dispatch (read,
   *  grep, glob, list) by promoting their agentName from "swarm" (no
   *  tools) to "swarm-read" (file-introspection tools). Lets proposers
   *  ground claims in actual file content instead of pre-fetched
   *  context. Default OFF — adds round-trips per proposer call; users
   *  opt in when they want the extra grounding. MoA only. */
  moaProposerTools?: boolean;
  /**
   * T192 (2026-05-04): opt-in forward chain — when this run completes,
   * automatically fire a follow-up run with the given preset using the
   * top extracted next-action (from this run's next-actions.json) as
   * the directive. Enables stigmergy → blackboard, council → blackboard,
   * etc. Default OFF (T2.3 only ships a chain HINT in the transcript).
   *
   * Recursion guard: the chained run has chainTo cleared so it can't
   * re-trigger. Chained run inherits cfg.repoUrl, localPath, model,
   * and all paid-provider settings; preset + userDirective are
   * replaced.
   */
  chainTo?: "blackboard" | "baseline";
  /**
   * T192 (2026-05-04): opt-in self-critique pass for the baseline preset.
   * After the baseline produces hunks, fire a second prompt that shows
   * the model its OWN hunks + asks it to APPROVE or REVISE before
   * commit. ~2× the cost; often catches obvious mistakes (search-text
   * not actually in file, missed caller updates, no-op replacements).
   *
   * Default off — preserves baseline's "thinnest honest comparison"
   * role for the eval scoreboard. Opt-in on a per-run basis when you
   * want the quality bump.
   */
  baselineSelfCritique?: boolean;
  /**
   * Task #102 + T2.2 (2026-05-04): opt-in wrap-up apply phase.
   *
   * **Debate-judge** (Task #102 original use): post-verdict "build"
   * round. After JUDGE returns a verdict with confidence ≥ medium and
   * a non-tie winner, the same 3 agents pivot to: PRO=implementer,
   * CON=reviewer, JUDGE=signoff. Switches the per-turn agentName from
   * "swarm-read" to "swarm".
   *
   * **All other discussion presets** (T2.2): after the deliverable +
   * next-actions JSON land, the lead agent fires ONE single-shot
   * worker prompt against the synthesized top action and applies the
   * resulting hunks via the same baseline apply path
   * (parseWorkerResponse → applyBaselineHunks → git commit). Best-
   * effort: parse failure / 0-hunks / conflict surface as a system
   * bubble + WrapUpApplyResult, the run stays in its terminal phase.
   *
   * Default OFF — preserves the discussion-only character of every
   * preset for users who don't want the swarm to write. Stigmergy
   * ignores the flag (exploration is repo-driven, not action-driven).
   * Blackboard ignores it (already write-capable natively). Baseline
   * ignores it (already does single-shot apply natively).
   */
  executeNextAction?: boolean;
  /**
   * Write phase mode for discussion presets. Replaces and generalizes
   * executeNextAction with more granular control:
   *
   * - "none" (default): discussion-only, no file writes. Preserves the
   *   legacy behavior for all presets except blackboard/baseline.
   * - "single": ONE implementer agent (or synthesizer) produces hunks
   *   after discussion completes. Reuses wrapUpApplyPhase infrastructure.
   *   Synthesizer produces { hunks: [...] } envelope instead of prose.
   * - "multi": each agent can propose hunks during their turn; preset-
   *   specific reconciliation (vote/judge/pick/merge) at end. Harder
   *   coordination; shipped after single-mode is stable.
   *
   * Blackboard and baseline ignore this flag (already write-capable).
   * Stigmergy ignores it (exploration-focused, not action-driven).
   */
  writeMode?: "none" | "single" | "multi";
  /**
   * Phase 2 (writeMode: multi): conflict resolution strategy when
   * multiple agents propose overlapping hunks.
   *
   * - "merge" — combine non-overlapping hunks; fail on any conflict
   * - "sequential" — apply in agent-index order; later sees earlier's result
   * - "vote" — agents vote on conflicting hunks; majority wins
   * - "judge" — designated judge picks best hunk from conflicting set
   * - "pick" — synthesizer picks one agent's full proposal
   *
   * Each preset has a default strategy matching its decision-making model:
   *   - Council → "vote"
   *   - MoA → "pick" (aggregator chooses)
   *   - Map-reduce → "merge" (isolated slices)
   *   - Debate-judge → "judge"
   *   - OW/OW-Deep → "sequential"
   *   - Round-robin → "vote"
   *   - Stigmergy → "merge" (file-isolated)
   *
   * User can override the per-preset default when needed.
   */
  conflictPolicy?: "merge" | "sequential" | "vote" | "judge" | "pick";
}
