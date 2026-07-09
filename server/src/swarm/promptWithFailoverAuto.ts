// W19 (2026-05-04): convenience wrapper around promptWithFailover for
// the non-blackboard runners.
//
// BlackboardRunner has its own per-run state (FailoverState) +
// localOllamaTags discovery + onFailover callback wired in. The 10
// other runners (RoundRobin, Council, OW, OW-Deep, DebateJudge,
// MapReduce, MoA, Stigmergy, RoleDiff, Baseline) want the same R1
// + R3 semantics with minimal ceremony — they don't carry persistent
// per-model attempt state (R10's degradation verdict needs ≥5
// samples; non-blackboard runners typically fire fewer prompts per
// agent than that anyway).
//
// This wrapper:
//   - reads the env defaults (SWARM_PROVIDER_FAILOVER /
//     SWARM_DEGRADATION_FALLBACK / SWARM_DEGRADATION_PREFERRED)
//   - lets a per-run chain override (cfg.providerFailover)
//   - uses a fresh ephemeral FailoverState per call (no R10
//     accumulation across calls — accept the trade-off for the
//     simpler call-site)
//
// Drop-in replacement for promptWithRetry — same arity, same
// PromptWithRetryOptions shape.

import type { Agent } from "../services/AgentManager.js";
import type { PromptWithRetryOptions } from "./promptWithRetry.js";
import { promptWithFailover, type FailoverConfig } from "./promptWithFailover.js";
import { config as appConfig } from "../config.js";


export async function promptWithFailoverAuto(
  agent: Agent,
  promptText: string,
  opts: PromptWithRetryOptions,
  perRunChain?: readonly string[],
  onFailover?: Parameters<typeof promptWithFailover>[5],
): Promise<unknown> {
  const cfg: FailoverConfig = {
    failoverChain:
      perRunChain && perRunChain.length > 0
        ? perRunChain
        : appConfig.SWARM_PROVIDER_FAILOVER,
    // R3 disabled here — non-blackboard runners don't run the
    // /api/tags discovery at start. Users who want R3 on these
    // presets should explicitly include local tags in their
    // failover chain (e.g. "anthropic/claude-haiku-4-5,llama3:8b").
    localTags: [],
    localPreferred: appConfig.SWARM_DEGRADATION_PREFERRED,
    // R10 disabled — needs persistent state across calls; this
    // wrapper uses ephemeral state.
    enableHealthSwap: false,
  };
  const combinedOnFailover: typeof onFailover = opts.manager
    ? (info) => {
        opts.manager!.updateAgentModel(agent.id, info.toModel);
        onFailover?.(info);
      }
    : onFailover;
  return promptWithFailover(
    agent,
    promptText,
    opts as any,
    { modelHealth: new Map() },
    cfg,
    combinedOnFailover,
  );
}
