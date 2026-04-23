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
}

// Every preset implementation fulfills this contract so the top-level
// Orchestrator can dispatch to it without caring which pattern is running.
export interface SwarmRunner {
  start(cfg: RunConfig): Promise<void>;
  stop(): Promise<void>;
  status(): SwarmStatus;
  injectUser(text: string): void;
  isRunning(): boolean;
}
