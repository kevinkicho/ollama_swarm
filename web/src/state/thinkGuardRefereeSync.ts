import { resolveThinkGuardRefereeBudget } from "@ollama-swarm/shared/thinkGuardBudget";
import type { RunConfigSnapshot } from "../types";
import type { SwarmStore } from "./store";

/** Recompute resolved referee budget from runConfig + prior usage. */
export function syncThinkGuardRefereeStore(
  s: SwarmStore,
  cfgOverride?: Partial<RunConfigSnapshot>,
): void {
  const cfg = cfgOverride ? { ...s.runConfig, ...cfgOverride } : s.runConfig;
  if (!cfg) {
    s.setThinkGuardReferee(undefined);
    return;
  }
  s.setThinkGuardReferee(
    resolveThinkGuardRefereeBudget({
      thinkGuardRefereeEnabled: cfg.thinkGuardRefereeEnabled,
      thinkGuardRefereeMaxCallsPerRun: cfg.thinkGuardRefereeMaxCallsPerRun,
      thinkGuardRefereeMinThinkChars: cfg.thinkGuardRefereeMinThinkChars,
      thinkGuardRefereeThinkTailMinChars: cfg.thinkGuardRefereeThinkTailMinChars,
      thinkGuardRefereeThinkTailMaxChars: cfg.thinkGuardRefereeThinkTailMaxChars,
      thinkGuardRefereeMaxOutputTokens: cfg.thinkGuardRefereeMaxOutputTokens,
      thinkGuardRefereeCallsUsed: s.thinkGuardReferee?.callsUsed ?? 0,
    }),
  );
}