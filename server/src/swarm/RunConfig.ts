import type { SwarmRole } from "./roles.js";
import type { PresetId } from "./SwarmRunner.js";

export interface RunConfig {
  repoUrl: string;
  localPath: string;
  agentCount: number;
  rounds: number;
  model: string;
  preset: PresetId;
  // optional user-authored directive that steers the blackboard planner
  // planner's first-pass contract. Threaded into PlannerSeed.userDirective
  // and incorporated into the first-pass contract prompt so criteria are
  // shaped by user intent from turn 1. Silently ignored by non-blackboard
  // presets (no auto-contract to shape).
  userDirective?: string;
  // per-preset knobs, surfaced by the Start-a-swarm form's Advanced section.
  // Advanced section. Each is ignored by presets that don't consume it:
  // only role-diff uses `roles`, only blackboard uses `councilContract`,
  // only debate-judge uses `proposition`.
  /** Custom role list for role-diff. Falls back to DEFAULT_ROLES when absent or empty. */
  roles?: SwarmRole[];
  /**
   * Per-run override for blackboard's `COUNCIL_CONTRACT_ENABLED` env flag.
   * When set, it wins over the env value for this run only. When absent,
   * the env flag decides. Lets the user A/B without restarting the server.
   */
  councilContract?: boolean;
  /**
   * Proposition text for debate-judge, captured at start time. Previously
   * users had to call `injectUser(text)` BEFORE `start()` to set the
   * proposition — awkward because the SetupForm submits start immediately.
   * `proposition`, when present, takes precedence over the inject path.
   */
  proposition?: string;
  /**
   * Unit 34: per-run ambition-ratchet cap. When present and > 0, this run
   * will climb tiers on "all criteria met" up to this many tiers total
   * (tier 1 = the initial contract). When 0, explicitly disables the
   * ratchet for this run. When absent, falls back to
   * `AMBITION_RATCHET_ENABLED` env (off → disabled, on → capped by
   * `AMBITION_RATCHET_MAX_TIERS`). Blackboard-only; silently ignored by
   * discussion presets.
   */
  ambitionTiers?: number;
  /**
   * Unit 35: per-run override for `CRITIC_ENABLED` env. When set, wins
   * over the env value for this run only. Blackboard-only; silently
   * ignored by discussion presets (no diff-commit path to gate).
   */
  critic?: boolean;
  /**
   * Unit 36: live URL of the app the swarm is working on, for
   * auditor-side UI verification via Playwright MCP (Unit 26). When
   * set AND `MCP_PLAYWRIGHT_ENABLED=true`, at audit time the runner
   * spawns an isolated `swarm-ui` agent, has it `browser_navigate`
   * to this URL + `browser_snapshot`, and feeds the snapshot's
   * accessibility tree into the auditor seed as additional
   * evidence for UI-flavored criteria ("renders home page",
   * "button X works"). Blackboard-only; user-supplied URL only —
   * this unit does NOT start the app on the user's behalf.
   */
  uiUrl?: string;
  /**
   * Unit 42: per-agent model overrides. When set, the planner agent
   * (and the planner-hosted critic / replanner / auditor sessions)
   * uses `plannerModel`, while worker agents use `workerModel`. Each
   * falls back to `model` when absent — so existing single-model
   * runs are unchanged. Both blackboard-only (other presets ignore
   * these and use `model` for every agent).
   *
   * Use case: heavy-lift cloud model for planning + verification
   * (e.g. `glm-5.1:cloud`), cheaper / faster model for high-volume
   * worker turns (e.g. `gemma4:31b-cloud`).
   */
  plannerModel?: string;
  workerModel?: string;
  /**
   * Unit 43: per-run wall-clock cap override (ms). When set, replaces the
   * baked-in 8-hour `WALL_CLOCK_CAP_MS` for THIS run only. The other two
   * caps (commits / todos) keep their hard-coded defaults — this knob
   * targets the "I want a quick 30-min battle test, not the full 8-h
   * budget" use case without rebuilding. Blackboard-only; other presets
   * have their own absolute-turn caps but no equivalent wall-clock loop
   * gate today.
   */
  wallClockCapMs?: number;
  /**
   * #296 (2026-04-28): pre-commit verification command for the
   * blackboard worker pipeline. When set, runs after each worker's
   * hunks are written to disk but BEFORE the git commit lands. On
   * non-zero exit the writes are reverted and the todo is marked
   * failed with the command's output as the reason — the replanner
   * sees verifyFailed=true and prompts the worker to fix the bug
   * rather than re-emit the same patch.
   *
   * Examples: "npm test", "bun test", "tsc --noEmit", "npm run lint".
   * Bounded to 60s wall-clock; longer commands get killed and treated
   * as failure.
   *
   * T171 (2026-05-04): also honored by the wrap-up apply phase
   * (executeNextAction-driven) for non-blackboard presets. Same
   * semantics — apply hunks, run command, revert + mark wrap-up
   * failed on non-zero exit, otherwise commit.
   */
  verifyCommand?: string;

  /**
   * NEW (priority 3): When true, workers are forbidden from directly
   * mutating the repo. All filesystem writes and git commits must go
   * through the auditor (via pending-commit + approve path).
   * This is the "auditor is the only one allowed to mutate the repo" guard.
   */
  auditorOnlyMutations?: boolean;

  /**
   * NEW: When true (or when auditorOnlyMutations is true), the auditor's
   * commit path will always run verifyCommand (if configured) and will
   * reject the commit on verify failure.
   */
  requireAuditorVerification?: boolean;

  /**
   * Task #124: optional per-run hard cap on total tokens consumed
   * (prompt + response). When set, the runner polls the proxy-backed
   * tokenTracker every cap-check tick; once cumulative-since-start
   * exceeds this number, the runner halts the same way wall-clock
   * does. User-supplied — no default, no implicit cap. Useful for
   * autonomous mode where wall-clock alone doesn't bound cost (a
   * stuck retry loop can burn tokens with little wall-clock movement).
   * Empty / undefined = no token cap (legacy behavior).
   */

  /** Marker: this run was started by the Brain-as-OS for self-improvement. */
  brainInitiated?: boolean;
  /** If brain-initiated, the proposal id that triggered it (for traceability across concurrent runs). */
  brainProposalId?: string;
  tokenBudget?: number;
  /**
   * Legacy compatibility flag. Blackboard planners now always use the
   * read-only swarm-planner profile and may inspect repository files as
   * needed. This flag is retained for saved-run/config compatibility.
   */
  plannerTools?: boolean;

  /**
   * When true (or when plannerTools is true), planner, workers, auditor, and
   * build workers gain access to web tools: web_search + web_fetch (via the
   * swarm-research / swarm-planner / swarm-builder-research profiles).
   * This enables directives that require live external research
   * (e.g. "find governmental data endpoints via internet searches").
   * Tools are provided via the same ToolDispatcher (opt-in "swarm-research" profile).
   * Use with care — results are truncated and subject to the model's ability
   * to follow up with specific URLs.
   */
  webTools?: boolean;
  /**
   * Experimental: MCP server specs (e.g. for full dynamic tool connection).
   * Currently the native web tools provide the capability; full MCP client
   * proxy (using @modelcontextprotocol/sdk) is the next layer.
   */
  mcpServers?: string;
  /** Local Ollama mode: strips :cloud from all model refs. */
  useLocal?: boolean;
  /** Multi-user: identifies who started this run. Default "default". */
  createdBy?: string;

  /** Correlation ID from the HTTP request that started this run. */
  reqId?: string;

  /**
   * When explicitly false, skip Brain run analysis (final run analysis,
   * insights for librarian role). Makes runs lighter. Defaults to true.
   */
  enableBrainAnalysis?: boolean;
  /**
   * Phase 2 of #314 (multi-provider cost cap): per-run dollar ceiling
   * for paid providers (Anthropic, OpenAI). Same 5-second cap-tick
   * cadence as wallClockCapMs / tokenBudget; on trip the runner halts
   * with reason "cap:cost". Ollama-only runs ignore the cap (every
   * record costs $0). Undefined / 0 = no cost cap. Recommended default
   * for paid-API runs is small (e.g. $0.50–$1.00) so a runaway retry
   * loop can't accidentally burn $100 of tokens. Blackboard-only for
   * now — discussion presets don't have the same 5s watchdog tick.
   */
  maxCostUsd?: number;
  /**
   * W13 wiring (2026-05-04): per-run provider failover chain. When
   * the active model hits a quota/auth wall, the runner swaps to
   * the next model in this list. Overrides the env-derived
   * SWARM_PROVIDER_FAILOVER default. Empty / absent → legacy
   * "single-model, no failover" behavior. Models are
   * provider-prefixed strings (e.g. "anthropic/claude-haiku-4-5",
   * "glm-5.1:cloud", "llama3:8b").
   */
  providerFailover?: readonly string[];
  /**
   * Legacy — in-run brain parse fallback is retired. Ignored at runtime.
   * Post-run brainOverseer analysis uses its own model config.
   */
  brainModel?: string;
  /**
   * Task #127: when no userDirective is set, run a one-shot
   * goal-generation pre-pass using the planner agent — it inspects
   * the repo and proposes 3-5 ambitious-but-feasible improvements,
   * then the top one becomes the directive for this run. Lifts the
   * swarm from "do something" to "do something that matters."
   * Default true. Set false to fall back to the legacy
   * planner-picks-from-scratch behavior. Blackboard-only; ignored by
   * other presets (which don't use userDirective).
   */
  autoGenerateGoals?: boolean;
  /**
   * Task #129: post-completion stretch-goal reflection. After a run
   * finishes successfully (not crashed, not user-stopped, has at
   * least one commit OR met-criteria > 0), the planner is asked one
   * meta-question: "what would the BEST version of this work have
   * done?". The answer is recorded as a `stretch_goals` transcript
   * summary so the next run (or the user) can use it as a directive.
   * Lifts the swarm from "did the contract" → "what could it have
   * done that was more ambitious?". Default true. Set false to
   * skip (saves one planner prompt per successful run).
   * Blackboard-only.
   */
  autoStretchReflection?: boolean;
  /**
   * 2026-05-02 (auto-rollback decision #5): opt-in auto-rollback of
   * commits attributed to criteria that ended at status="unmet" at
   * end-of-run. When false (default), nothing is rolled back — the
   * deliverable still surfaces "rollback suggestions" the user can
   * apply manually. When true, the runner runs `git reset --hard` to
   * unwind unmet-criterion commits, refusing if there's collateral
   * (commits from other criteria interleaved). Blackboard-only.
   */
  autoRollback?: boolean;
  /**
   * Task #128: per-commit independent verifier. When true, between
   * critic-accept and disk-write a verifier agent reads the todo +
   * the proposed diff and issues a verdict (verified / partial /
   * false / unverifiable). FALSE blocks the commit (markStale →
   * replan). Critical unblocker for autonomous mode where no human
   * reviews each commit. Adds one prompt per commit; default false
   * (opt-in). Blackboard-only.
   */
  verifier?: boolean;
  /**
   * Post-synthesis critique: runs a critic agent after any synthesis
   * pass (council consensus, OW lead plan, map-reduce reducer) to
   * find gaps and produce a revised synthesis. Uses the MoA
   * self-critique pattern adapted for general use. Default false
   * (opt-in).
   */
  postSynthesisCritique?: boolean;
  /**
   * Plan 6: round-robin dispositions for blackboard workers. When true,
   * each worker rotates through critic/synthesizer/gap-finder/builder
   * dispositions across cycles so the same worker approaches todos from
   * different angles. Default false. Blackboard-only.
   */
  workerDispositions?: boolean;
  /**
   * Task #132: continuous mode — run-against-budget instead of
   * run-against-rounds. When true, the runner treats `rounds` as
   * effectively unbounded; the run halts on cap (tokenBudget /
   * wallClockCapMs / blackboard's commits/todos caps) or user
   * stop. Required: at least one budget cap must be set, otherwise
   * the route layer rejects the start (else this would be an
   * infinite loop). Default false. Compatible with all presets;
   * blackboard is already cap-driven so the flag is a no-op there
   * but still validated. Pairs with #133 (token tracking) +
   * #124 (token-budget) which together make the budget gate real.
   */
  continuous?: boolean;
  /**
   * Post-round critique hook: after each discussion round, pick the
   * agent with the fewest turns and prompt it to critique the recent
   * entries. The critique is appended as a system message visible to
   * all agents next round. Costs 1 extra prompt per round. Default
   * false.
   */
  postRoundCritique?: boolean;
  /**
   * Task #130: persistent cross-run memory (`<clone>/.swarm-memory.jsonl`).
   * On run-start, the planner seed surfaces the most recent N
   * lessons-learned entries from prior runs against this clone.
   * On successful run-end (after stretch reflection, before summary
   * write), the planner produces a 2-4 bullet lesson distillation
   * which gets appended. Default true; set false to skip both the
   * read AND the write. Blackboard-only.
   */
  autoMemory?: boolean;
  /**
   * Task #177: long-horizon DESIGN memory at <clone>/.swarm-design/.
   * Three markdown files: north-star.md (the long-term vision),
   * decisions.md (append-only design choices log), roadmap.md
   * (ranked next features). Read at planner-seed time + updated by
   * a post-run reflection pass that runs after memory distillation.
   * Default true; set false to skip both read AND write. Blackboard-only.
   */
  autoDesignMemory?: boolean;
  /**
   * Unit 51: opt-in to reload the prior run's contract + tier state
   * directly from `<clone>/blackboard-state.json` instead of having
   * the planner re-derive a first-pass contract. Pairs with the
   * build-on-existing-clone work pattern — when the user is iterating
   * on the same target, this avoids planner non-determinism (run #2's
   * contract framing differing from run #1) and skips the long
   * first-pass-contract round entirely. When the snapshot is missing,
   * unparseable, or has no contract, the runner silently falls back
   * to the normal first-pass-contract path. Blackboard-only.
   */
  resumeContract?: boolean;
  /**
   * Council-only: load pending execution todos from
   * `<clone>/logs/<runId>/pending-execution-todos.json`, skip contract
   * derivation, and drain the queue (execution-only cycle).
   */
  resumeExecutionFromRunId?: string;
  /**
   * Unit 58: opt-in to spawn a 4th agent dedicated to the AUDITOR
   * role. Without this flag, agent-1 wears 4 hats (planner +
   * replanner + auditor + critic-via-fresh-session) — Unit 46b's
   * audit-prompt truncation is a band-aid for the bottleneck. With
   * this flag, audit calls route to a dedicated agent so workers
   * keep draining new todos in parallel with the audit pass, and
   * the auditor's fresh session avoids anchoring on the planner's
   * prior decisions. Total agents = cfg.agentCount + 1 (the +1 is
   * the auditor; existing worker pool size is preserved).
   * Blackboard-only.
   */
  dedicatedAuditor?: boolean;
  /**
   * Unit 58: per-run model override for the auditor agent (when
   * dedicatedAuditor=true). Falls back to plannerModel, then to
   * model. Useful when you want a smaller/faster model for audit
   * (it's diff/criteria reasoning — doesn't need the planner's
   * design taste). Ignored when dedicatedAuditor is false.
   */
  auditorModel?: string;
  /**
   * Unit 59 (59a — static per-worker role): when true, each worker
   * gets a deliberately-different role bias (correctness /
   * simplicity / consistency, cycling through workerRoles.ts) that
   * prepends its system prompt. Same model + same todo, but the
   * commits across workers carry distinct biases — research-backed
   * (MetaGPT, ChatDev, AutoGen, AgentVerse) for outperforming a
   * flat worker pool. Default off; opt in for runs where you want
   * the diversity. Blackboard-only.
   */
  specializedWorkers?: boolean;
  /**
   * Unit 60: when true, the critic at commit time is a 3-critic
   * ensemble (substance / regression / consistency, each with a
   * different system prompt) instead of a single critic. Verdict
   * is majority-vote (2-of-3 accept = accept). Triples critic
   * cost per commit; only meaningful when cfg.critic !== false
   * (no point ensembling a disabled critic). Default off.
   */
  criticEnsemble?: boolean;
  /**
   * #87 (2026-05-01): self-consistency on worker hunks. When > 1, each
   * worker turn runs the SAME prompt K times (sequentially on the same
   * agent) and the runner picks the hunks-envelope that K-1 or more
   * other attempts agreed on (majority vote on normalized envelope
   * shape). Improves quality on tasks with > 1 plausible patch at the
   * cost of K× tokens per todo. Capped at 5 to bound cost. Default 1
   * (current single-worker behavior). Blackboard-only — discussion
   * presets ignore this.
   */
  selfConsistencyK?: number;
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
   * #98 (2026-05-01): heterogeneous models per MoA layer. The whole
   * point of MoA per the original Together AI paper is that N small
   * fast models proposing + 1 big reasoning model aggregating beats
   * any single model alone. Without per-layer models, both layers use
   * cfg.model and the test is contaminated.
   *
   * - moaProposerModel: model used for the N proposers in Layer 1
   *   (cheap + fast, e.g. gemma4:31b-cloud)
   * - moaAggregatorModel: model used for the K aggregators in Layer 2
   *   (slower + smarter, e.g. deepseek-v4-flash:cloud or sonnet)
   *
   * Each falls back to cfg.model when absent — preserves single-model
   * behavior. MoA-only.
   */
  moaProposerModel?: string;
  moaAggregatorModel?: string;
  /**
   * T196 (2026-05-04): heterogeneous proposers UI substrate. When set,
   * each proposer N uses moaProposerModels[N % length] instead of the
   * single moaProposerModel. The whole point of MoA is N DIFFERENT
   * small models proposing — beats N copies of the same model. The
   * UI surface is deferred (per-proposer dropdown form work); use
   * via API for now.
   *
   * Examples (per the original Together AI paper):
   *   ["gemma4:31b-cloud", "qwen3-coder-next:cloud", "deepseek-v4-flash:cloud"]
   *   ["llama3:8b", "mistral-large-3:7b", "qwen2.5-coder:7b"]
   *
   * Falls back to moaProposerModel → cfg.model when absent.
   * MoA-only.
   */
  moaProposerModels?: readonly string[];
  /**
   * T196 (2026-05-04): per-tier model routing for OW-Deep. Each tier
   * uses a different model: orchestrator (strategy / reasoning),
   * mid-leads (tactics / reasoning), workers (implementation /
   * coding-tier). Same value-prop as MoA's heterogeneous proposers
   * but at the OW-Deep tier boundary. Existing cfg.workerModel
   * already exists (also used by blackboard); this adds the orch +
   * mid-lead tiers.
   *
   * Example:
   *   orchestratorModel: "deepseek-v4-flash:cloud"  // strategy
   *   midLeadModel: "glm-5.1:cloud"                // tactics
   *   workerModel: "gemma4:31b-cloud"              // implementation
   *
   * Each falls back to cfg.model when absent. OW-Deep only.
   * The UI surface is deferred (per-tier dropdown form work).
   */
  orchestratorModel?: string;
  midLeadModel?: string;
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
  /** T198c: blackboard adaptive worker pool sizing. When set
   *  (with min/max), a background watchdog logs recommendations
   *  ("could spawn 2 more workers" / "could scale down 1") based on
   *  todo backlog vs current worker count. First-cut: LOGS ONLY,
   *  doesn't actually spawn or kill agents (dynamic AgentManager
   *  spawn is days of substrate work). Blackboard only. */
  adaptiveWorkers?: { min: number; max: number };
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
  /** T198h: blackboard test-driven todos. When true, the planner
   *  prompt is instructed to include a "verification step" per
   *  todo (e.g., "run `npm test path/related.test.ts` after impl").
   *  Auditor checks the verification ran. First-cut: pushes EXISTING
   *  tests; doesn't generate new failing tests (test-scaffolding
   *  generator is days of work). Blackboard only. */
  testDrivenTodos?: boolean;
  /** Q4 (2026-05-04): best-of-N at the turn level. When set, the
   *  runner fires K samples for high-stakes turns + a judge picks
   *  (length heuristic when no judge available). Generalizes T199's
   *  self-consistency-on-hunks pattern. K cap = 5 (matching the
   *  existing self-consistency cap). Default 1 (no fan-out). Honored
   *  by runners that adopt the shared `bestOfNTurn.ts` helpers. */
  bestOfNTurn?: number;
  /** Q6 (2026-05-04): dynamic role picker for round-robin / role-diff.
   *  When set, the runner consults a planner-tier meta-prompt to pick
   *  the next role based on what the conversation NEEDS (vs fixed
   *  cycle). One extra prompt per turn. Default OFF — fixed-cycle
   *  rotation preserves the legacy deterministic behavior. Honored
   *  via the shared `dynamicRolePicker.ts` helpers. */
  dynamicRolePicker?: boolean;
  /** Q7 (2026-05-04): debate-judge swap-sides bias check. After the
   *  judge's verdict, run a SECOND verdict pass with PRO/CON labels
   *  swapped. If the same SIDE wins both times, the verdict was
   *  driven by labeling (judge bias) — flag low confidence + skip
   *  the post-verdict build phase. Default OFF — adds 1 judge call
   *  per debate. Debate-judge only. */
  swapSidesBiasCheck?: boolean;
  /** Q5 (2026-05-04): dissent preservation in synthesis. When set,
   *  council/MoA/round-robin synthesizer prompts emit THREE sections
   *  (majority view + minority report + open questions) instead of
   *  one consolidated answer. Stops "polite convergence" from
   *  averaging away the most informative contrarian insight.
   *  Default OFF — longer output. Honored via the shared
   *  `dissentPreservation.ts` helpers. */
  preserveDissent?: boolean;
  /** Q8 (2026-05-04): stigmergy pheromone decay + saturation cap.
   *  When set, StigmergyRunner's per-file picker applies multiplicative
   *  decay to avgInterest per elapsed round + filters out files that
   *  hit DEFAULT_MAX_REVISITS=8. Stops hot-spot loops. Default OFF —
   *  preserves the legacy "all visits weighted equal forever"
   *  behavior. Stigmergy only. */
  pheromoneDecay?: boolean;
  /** Q9 (2026-05-04): map-reduce mid-cycle finding broadcast. When set,
   *  high-confidence findings (≥7/10) from completed mappers are
   *  surfaced in the prompt of mappers that haven't started THIS round.
   *  Stops "siloed mapper" failures where two mappers independently
   *  miss the same insight. Cap at MAX_BROADCAST_PER_MAPPER=5.
   *  Default OFF — preserves the legacy "all pooling at reduce time"
   *  behavior. Map-reduce only. */
  midCycleBroadcast?: boolean;
  /** Q10 (2026-05-04): pre-flight verify dry-run for blackboard. When
   *  set + cfg.verifyCommand is configured, workers stage their hunks
   *  in a temp branch + run verifyCommand BEFORE committing. Failed
   *  verify triggers a re-prompt with the verify error in context;
   *  exhausted retries → todo skipped. Catches breakage at the worker
   *  turn, not post-commit. Default OFF — 2× wall-clock per todo.
   *  Blackboard only. */
  preflightDryRun?: boolean;
  /** Q11 (2026-05-04): hunk placement RAG. When set, the worker's
   *  hunk-emit prompt includes top-3 most-similar past successful
   *  (todo, hunk-response) pairs from `.swarm-memory.jsonl` as
   *  few-shot examples. Specific to repos with prior runs.
   *  Token-overlap (Jaccard) similarity; capped to keep prompts
   *  bounded. Default OFF — biases the model toward historical
   *  patterns; not always desirable in evolving repos. Blackboard only. */
  hunkRag?: boolean;
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
  /** Q2 (2026-05-04): failure-pattern memory at run start. When set,
   *  the runner reads `.swarm-memory.jsonl` from the clone path and
   *  surfaces the most-recent N "failure" + "success" entries to the
   *  planner via the seed prompt. Lets a planner avoid re-trying
   *  known dead ends + replicate known-working approaches. Default
   *  OFF — adds prompt tokens to every planner seed. Currently
   *  honored by: BlackboardRunner planner seed (other runners adopt
   *  via `failurePatternSeed.ts` helper). */
  failurePatternSeed?: boolean;
  /** Q1 (2026-05-04): self-critique pass. When set, the runner sends
   *  high-stakes turns BACK to the same agent with a critique prompt
   *  before shipping. Verdict + refined output replace the original
   *  when the model flags issues. Default OFF (doubles per-turn
   *  latency). Currently honored by: DebateJudgeRunner judge verdict.
   *  Other runners adopt incrementally via the shared
   *  `selfCritique.ts` helpers. */
  selfCritique?: boolean;
  /** T-Item-StigBb (2026-05-04): blackboard worker dispatch with
   *  stigmergy preference. When true, the worker dequeue picks among
   *  pending TODOs by preferring those whose `expectedFiles` overlap
   *  LEAST with already-committed files in this run. The intuition:
   *  spread the swarm's edits across the repo rather than letting one
   *  hot-spot dominate. Pure pheromone-style anti-attraction (avoid
   *  recently-visited files, not seek them). Default OFF — strict
   *  FIFO + tag-match preserves existing behavior. Blackboard only. */
  stigmergyOnBlackboard?: boolean;
  /** Plan 3: run ID to load heatmap from (future: cross-run pheromone
   *  carry). When set, the blackboard worker seed includes hot files
   *  from a prior or concurrent stigmergy run. Blackboard-only. */
  pheromoneHotseed?: string;
  /** Plan 3: explicit file list to seed worker attention. When set,
   *  these files are surfaced in the worker prompt as hot-file context
   *  regardless of stigmergy state. Blackboard-only. */
  pheromoneHotFiles?: string[];
  /** T-Item-CouncilRec (2026-05-04): council reconcile policy.
   *  Picks how the council settles on a final answer:
   *  - "revise" (default): existing behavior — agents see peer drafts
   *    starting Round 2 and revise; lead synthesizes at end.
   *  - "vote": after final round, each drafter casts ONE vote for the
   *    BEST OTHER draft (no self-votes). Most-voted draft wins; tied
   *    votes broken by lowest agent index. Cheap (N small prompts).
   *  - "judge": after final round, an extra synthesis prompt explicitly
   *    asks the lead agent to PICK ONE draft as canonical (vs.
   *    "merge" which the existing synthesis already does).
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
  /** T-Item-AutoRoute (2026-05-04): runtime per-prompt model routing.
   *  When true, runners that normally fan all agents through cfg.model
   *  consult per-tier overrides on a per-prompt basis using the role
   *  category (planner / worker / auditor / judge). Lets a user run
   *  cfg.workerModel: "gemma4:31b-cloud" + cfg.plannerModel:
   *  "glm-5.1:cloud" without having to set per-agent overrides.
   *  Default OFF — preserves the legacy "one model for everything"
   *  shape. Currently honored by: orchestrator-worker, map-reduce
   *  (other runners adopt incrementally; the helper is shared). */
  dynamicModelRoute?: boolean;
  /** T-Item-MoaTools (2026-05-04): MoA proposer tool access. When true,
   *  proposers (layer-1 agents) get read-only tool dispatch (read,
   *  grep, glob, list) by promoting their agentName from "swarm" (no
   *  tools) to "swarm-read" (file-introspection tools). Lets proposers
   *  ground claims in actual file content instead of pre-fetched
   *  context. Default OFF — adds round-trips per proposer call; users
   *  opt in when they want the extra grounding. MoA only. */
  moaProposerTools?: boolean;
  /** T-Item-3 (2026-05-04): blackboard in-flight parallel hypothesis.
   *  When true, alternatives emitted with `[hypothesis: A/B/C]` tags
   *  are dispatched to workers in PARALLEL (rather than sequentially).
   *  First alternative to commit wins; the others auto-skip with reason
   *  "alternative <id> landed first". Conflict detection: alternatives
   *  with overlapping expectedFiles serialize within their group.
   *  Auditor sees the group outcome (winner + skipped) rather than
   *  treating each as an independent todo.
   *  Requires testDrivenTodos OR auditorParallelHypothesis to actually
   *  emit hypothesis-tagged todos. Blackboard only. */
  parallelHypothesisInFlight?: boolean;
  /**
   * Debate-judge auditor: replace Blackboard's single-agent auditor pass
   * with an optional 2-round debate (PRO/CON/JUDGE) where PRO argues
   * "criteria met", CON argues "criteria not met", and JUDGE issues a
   * structured verdict with confidence. Adversarial pressure catches gaps
   * that single-reviewer audits miss. Uses the auditor agent for all three
   * roles (different prompts provide the framing). Default false.
   * Blackboard-only.
   */
  debateAudit?: boolean;
  /**
   * Maximum debate rounds per criterion when debateAudit is true.
   * If the first round judge confidence is "low" and this is >= 2,
   * a second round runs with the additional evidence. Default 1, max 2.
   * Blackboard-only; ignored when debateAudit is false.
   */
  debateAuditRounds?: number;
  /** T198i: blackboard auditor parallel hypothesis. When true + last
   *  auditor verdict was "partial", next planner cycle's prompt
   *  instructs the planner to propose 2-3 ALTERNATIVE approaches to
   *  the unmet criterion. First-cut: sequential todos (not parallel
   *  in-flight); auditor picks whichever lands first by examining
   *  next-cycle commits. Blackboard only. */
  parallelHypothesis?: boolean;
  /**
   * T193 (2026-05-04): per-disposition model routing for round-robin
   * (no-roles variant). Maps each disposition to a model id; the
   * runner uses promptWithRetry's modelOverride to call that model
   * for the disposition's turns. Plays to the open-weights-
   * parallelism value prop — Critic/Gap-finder benefit from a
   * reasoning-tier model while Builder/Synthesizer benefit from a
   * coding-tier (faster, cheaper). Default off (every disposition
   * uses cfg.model). Round-robin only.
   *
   * Example:
   *   { critic: "deepseek-v4-flash:cloud",
   *     "gap-finder": "deepseek-v4-flash:cloud",
   *     synthesizer: "glm-5.1:cloud",
   *     builder: "gemma4:31b-cloud" }
   */
  dispositionModels?: {
    critic?: string;
    synthesizer?: string;
    "gap-finder"?: string;
    builder?: string;
  };
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
   * Pipeline preset: chains multiple sub-runs together. Each phase's
   * transcript + deliverable feeds the next phase's seed directive.
   * When set AND preset is "pipeline", the PipelineRunner executes
   * the phases sequentially. Absent → DEFAULT_PIPELINE used.
   */
  pipeline?: import("./pipelinePhases.js").PipelineConfig;

  /**
   * Internal: set by PipelineRunner for phases after the first (i>0).
   * When true, sub-phases skip re-emitting the clone-level seed messages
   * (Memory surfaced, Design memory, Seed:, Goal-gen pre-pass) because
   * those describe the shared clone and were already emitted by phase 0.
   * The sub-phase still receives the piped directive + prior transcript.
   */
  suppressSeedMessages?: boolean;

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
   * Per-run override for the V2 worker pipeline (`USE_WORKER_PIPELINE_V2`
   * env flag). When set, wins over the env value for THIS run only. When
   * absent, the env flag decides. Lets the user A/B without restarting
   * the dev server — useful while V2 is parallel-track and we want
   * head-to-head runs against the same repo. Blackboard-only; silently
   * ignored by discussion presets (no worker write path to gate).
   */
  useWorkerPipeline?: boolean;
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
   * Model for the write phase when writeMode !== "none". Falls back to
   * cfg.model when absent. Useful when you want a cheaper/faster model
   * for the discussion phase but a capable model for hunk generation.
   * Ignored when writeMode is "none" or absent.
   */
  writeModel?: string;
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
  /**
   * Issue #3 (2026-04-27): override the sibling-model used when the
   * planner returns 0 valid todos. Absent → look up sibling from the
   * hardcoded REASONING-tier pair (deepseek↔nemotron). Set explicitly
   * to use a different model (e.g. "glm-5.1:cloud") when neither
   * sibling-tier model fits. Set to the same value as `plannerModel`
   * to effectively disable fallback. Blackboard-only.
   */
  plannerFallbackModel?: string;
  /**
   * Task #36: app-level run id minted by the Orchestrator at run-start
   * (Unit 52d) and stashed into RunConfig here so runners can forward
   * it to their summary builders. Lets summary.json carry the same
   * runId the UI shows, so the history dropdown can render it as a
   * column and click-to-copy matches the live IdentityStrip chip.
   *
   * Not user-settable — the route schema doesn't accept this field;
   * Orchestrator.start overwrites any caller-provided value. Optional
   * on the type so tests that build bare RunConfigs stay valid.
   */
  runId?: string;
  /**
   * Phase 4a of #243: the explicit topology used for this run, set by
   * the route layer (synthesized from agentCount + per-role models
   * when the client didn't post one). Threaded into RunSummary so
   * History can show the exact agent specs and review-mode hydration
   * can recreate the grid as it was. Not consumed at runtime in
   * Phase 1 — the runners still use agentCount/plannerModel/etc. —
   * but Phase 2 will start consuming per-row model overrides.
   */
  topology?: import("../../../shared/src/topology.js").Topology;
}
