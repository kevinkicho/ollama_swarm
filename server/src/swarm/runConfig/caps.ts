// Partial RunConfig fields — RunConfigCaps
export interface RunConfigCaps {
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
   * Unit 43: per-run wall-clock cap override (ms). When set, replaces the
   * baked-in 8-hour `WALL_CLOCK_CAP_MS` for THIS run only. The other two
   * caps (commits / todos) keep their hard-coded defaults — this knob
   * targets the "I want a quick 30-min battle test, not the full 8-h
   * budget" use case without rebuilding. Blackboard-only; other presets
   * have their own absolute-turn caps but no equivalent wall-clock loop
   * gate today.
   */
  wallClockCapMs?: number;
  tokenBudget?: number;
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
   * Wall-clock cap for seeding + contract + initial planner pass (ms).
   * Default 15 min. Does not count worker execution time.
   */
  planningWallClockCapMs?: number;
  /**
   * Task #132: continuous mode — run-against-budget instead of
   * run-against-rounds. When true, the runner treats `rounds` as
   * effectively unbounded; the run halts on cap (tokenBudget /
   * wallClockCapMs / blackboard's commits cap) or user
   * stop. Required: at least one budget cap must be set, otherwise
   * the route layer rejects the start (else this would be an
   * infinite loop). Default false. Compatible with all presets;
   * blackboard is already cap-driven so the flag is a no-op there
   * but still validated. Pairs with #133 (token tracking) +
   * #124 (token-budget) which together make the budget gate real.
   */
  continuous?: boolean;
  /** T198c: blackboard adaptive worker pool sizing. When set
   *  (with min/max), a background watchdog logs recommendations
   *  ("could spawn 2 more workers" / "could scale down 1") based on
   *  todo backlog vs current worker count. First-cut: LOGS ONLY,
   *  doesn't actually spawn or kill agents (dynamic AgentManager
   *  spawn is days of substrate work). Blackboard only. */
  adaptiveWorkers?: { min: number; max: number };
}
