import type { AgentManager } from "../services/AgentManager.js";
import type { RepoService } from "../services/RepoService.js";
import type { SwarmEvent, SwarmStatus } from "../types.js";
import type { SwarmRole } from "./roles.js";

export type PresetId =
  | "round-robin"
  | "blackboard"
  | "role-diff"
  | "council"
  | "orchestrator-worker"
  | "orchestrator-worker-deep"
  | "debate-judge"
  | "map-reduce"
  | "stigmergy";

export interface RunConfig {
  repoUrl: string;
  localPath: string;
  agentCount: number;
  rounds: number;
  model: string;
  preset: PresetId;
  // Unit 25: optional user-authored directive that steers the blackboard
  // planner's first-pass contract. Threaded into PlannerSeed.userDirective
  // and incorporated into the first-pass contract prompt so criteria are
  // shaped by user intent from turn 1. Silently ignored by non-blackboard
  // presets (no auto-contract to shape).
  userDirective?: string;
  // Unit 32: per-preset knobs, surfaced by the Start-a-swarm form's
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
   * worker turns (e.g. `gemma4:31b-cloud`). The opencode.json the
   * runner writes declares ALL distinct model names so opencode
   * knows about every one before any session.create fires.
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
   * Task #124: optional per-run hard cap on total tokens consumed
   * (prompt + response). When set, the runner polls the proxy-backed
   * tokenTracker every cap-check tick; once cumulative-since-start
   * exceeds this number, the runner halts the same way wall-clock
   * does. User-supplied — no default, no implicit cap. Useful for
   * autonomous mode where wall-clock alone doesn't bound cost (a
   * stuck retry loop can burn tokens with little wall-clock movement).
   * Empty / undefined = no token cap (legacy behavior).
   */
  tokenBudget?: number;
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
   * Task #102: opt-in post-verdict "build" round for debate-judge.
   * After the JUDGE returns a verdict with confidence ≥ medium and a
   * non-tie winner, the same 3 agents pivot to: PRO=implementer
   * (file-edits to action the verdict's nextAction), CON=reviewer
   * (verifies + flags issues), JUDGE=signoff. Switches the per-turn
   * agentName from "swarm-read" to "swarm" so file-edit tools become
   * available. Default off — preserves the discussion-only character
   * of debate-judge for users who don't want the swarm to write.
   * Debate-judge-only; ignored by other presets.
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

export interface RunnerOpts {
  manager: AgentManager;
  repos: RepoService;
  emit: (e: SwarmEvent) => void;
  // Unit 19: optional diagnostic-log channel for non-WS records (per-call
  // timing, raw SDK events, warmup outcomes). Defaults to a no-op so
  // existing tests don't have to construct one. Lands in the same
  // logs/current.jsonl that the WS event logger writes.
  logDiag?: (record: unknown) => void;
  // V2 Step 1: Ollama base URL (without /v1 suffix). Threaded from the
  // Orchestrator so the runner can pass it to OllamaClient when
  // USE_OLLAMA_DIRECT=1 is set. Optional — falls through to a default
  // if the runner doesn't need it (non-blackboard presets unchanged).
  ollamaBaseUrl?: string;
}

// Every preset implementation fulfills this contract so the top-level
// Orchestrator can dispatch to it without caring which pattern is running.
export interface SwarmRunner {
  start(cfg: RunConfig): Promise<void>;
  stop(): Promise<void>;
  // Task #167: soft-stop. Optional — when undefined, the orchestrator
  // falls back to stop(). Blackboard implements it: workers finish
  // their currently-claimed todo, no new claims permitted, then
  // escalate to hard stop. Discussion presets have nothing analogous
  // (their parallel-round structure can't be cleanly drained
  // mid-round) so they leave it undefined and get hard-stop.
  drain?(): Promise<void>;
  status(): SwarmStatus;
  injectUser(text: string): void;
  isRunning(): boolean;
}
