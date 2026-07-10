// Partial RunConfig fields — RunConfigBlackboard
export interface RunConfigBlackboard {
  /**
   * Per-run override for blackboard's `COUNCIL_CONTRACT_ENABLED` env flag.
   * When set, it wins over the env value for this run only. When absent,
   * the env flag decides. Lets the user A/B without restarting the server.
   */
  councilContract?: boolean;
  /**
   * When council contract is on: one lead explores, then all agents emit-only
   * drafts from the shared brief. Default **false** (independent explore→emit
   * per agent). Set true for shared-explore contract drafting.
   */
  councilSharedExplore?: boolean;
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
   * Project knowledge graph context injection for planner/workers.
   * When true, inject cross-run file map from `.swarm/project-graph.json`.
   * When false, never inject. When absent, auto-on for blackboard runs
   * with a non-empty userDirective.
   */
  projectGraphContext?: boolean;
  /**
   * Experimental: MCP server specs (e.g. for full dynamic tool connection).
   * Currently the native web tools provide the capability; full MCP client
   * proxy (using @modelcontextprotocol/sdk) is the next layer.
   */
  mcpServers?: string;
  /**
   * When explicitly false, skip Brain run analysis (final run analysis,
   * insights for librarian role). Makes runs lighter. Defaults to true.
   */
  enableBrainAnalysis?: boolean;
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
   * Planning fast path: skip goal pre-pass, lower explore tool caps, prefer
   * seed grounding over repo tours. Blackboard-only. Ignored for stigmergy /
   * map-reduce presets (Phase 5 opt-out).
   */
  planningFastPath?: boolean;
  /**
   * D11: skip LLM contract derivation and install a synthetic contract from
   * the user directive + prefetched UI file paths. Blackboard-only; also
   * auto-triggers for scoped UI directives when planningFastPath is on.
   */
  skipContractDerivation?: boolean;
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
   * Plan 6: round-robin dispositions for blackboard workers. When true,
   * each worker rotates through critic/synthesizer/gap-finder/builder
   * dispositions across cycles so the same worker approaches todos from
   * different angles. Default false. Blackboard-only.
   */
  workerDispositions?: boolean;
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
  /** T198h: blackboard test-driven todos. When true, the planner
   *  prompt is instructed to include a "verification step" per
   *  todo (e.g., "run `npm test path/related.test.ts` after impl").
   *  Auditor checks the verification ran. First-cut: pushes EXISTING
   *  tests; doesn't generate new failing tests (test-scaffolding
   *  generator is days of work). Blackboard only. */
  testDrivenTodos?: boolean;
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
  /** Q2 (2026-05-04): failure-pattern memory at run start. When set,
   *  the runner reads `.swarm-memory.jsonl` from the clone path and
   *  surfaces the most-recent N "failure" + "success" entries to the
   *  planner via the seed prompt. Lets a planner avoid re-trying
   *  known dead ends + replicate known-working approaches. Default
   *  OFF — adds prompt tokens to every planner seed. **Wired** in
   *  blackboard `buildSeed` (`contractBuilder.ts`). */
  failurePatternSeed?: boolean;
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
   * Per-run override for the V2 worker pipeline (`USE_WORKER_PIPELINE_V2`
   * env flag). When set, wins over the env value for THIS run only. When
   * absent, the env flag decides. Lets the user A/B without restarting
   * the dev server — useful while V2 is parallel-track and we want
   * head-to-head runs against the same repo. Blackboard-only; silently
   * ignored by discussion presets (no worker write path to gate).
   */
  useWorkerPipeline?: boolean;
}
