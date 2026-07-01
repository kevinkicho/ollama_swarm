// Council brain adapter — adapts the council preset for the brain's
// proposal review role. The council's 3-agent independent analysis +
// cross-examination + synthesis cycle produces higher-quality proposals
// than a single brain agent.

import type { Agent } from "../../../services/AgentManager.js";
import type { InteractionChain } from "./interactionTracker.js";
import type { PatternSummary, ExceptionEvent } from "./exceptionCollector.js";

export interface CouncilBrainInput {
  chains: InteractionChain[];
  exceptions: PatternSummary;
  priorImprovements: string[];
  swarmCodebasePath: string;
}

/**
 * Build the user directive for a council brain run.
 * The directive tells the council agents to analyze interaction chains
 * and propose concrete patches to improve the swarm system.
 */
export function buildCouncilBrainDirective(input: CouncilBrainInput): string {
  const chainText = input.chains
    .slice(0, 20)
    .map((chain) => {
      const events = chain.events.map((e) => `  - ${e.type}: ${e.reason}`).join("\n");
      return `Chain for todo ${chain.todoId}:\n${events}`;
    })
    .join("\n\n");

  const patternText = input.exceptions.recurringPatterns
    .map((p) => `- ${p.pattern} (${p.count}x)`)
    .join("\n");

  const priorText = input.priorImprovements.length > 0
    ? input.priorImprovements.map((p) => `- ${p}`).join("\n")
    : "(no prior improvements)";

  return [
    "Analyze the swarm system to propose improvements. You have access to:",
    "",
    "1. Interaction chains from the last run (shown below)",
    "2. Exception patterns (shown below)",
    "3. Prior improvements (shown below)",
    "4. The swarm's source code (this repo)",
    "",
    "Your job: propose concrete patches to improve the swarm system.",
    "",
    "For each improvement:",
    "- Identify the root cause (not just symptoms)",
    "- Propose a specific code change (search/replace hunks)",
    "- Target a real file in this repo",
    "- Explain why this fix prevents the pattern from recurring",
    "",
    "Do NOT propose changes to the project code the swarm works on — only to the",
    "swarm system itself. Focus on: prompt improvements, rule additions, new detectors,",
    "config changes, and architecture fixes.",
    "",
    "=== INTERACTION CHAINS ===",
    chainText || "(no interaction chains recorded)",
    "",
    "=== EXCEPTION PATTERNS ===",
    patternText || "(no recurring patterns)",
    "",
    "=== PRIOR IMPROVEMENTS ===",
    priorText,
  ].join("\n");
}

/**
 * Build the RunConfig for a council brain run.
 */
export function buildCouncilBrainConfig(
  input: CouncilBrainInput,
  model: string,
): Record<string, unknown> {
  return {
    repoUrl: input.swarmCodebasePath,
    localPath: input.swarmCodebasePath,
    agentCount: 3,
    rounds: 3,
    model,
    preset: "council",
    councilReconcile: "vote", // 2-vs-1 majority
    userDirective: buildCouncilBrainDirective(input),
    wallClockCapMs: 30 * 60 * 1000, // 30 min cap
  };
}
