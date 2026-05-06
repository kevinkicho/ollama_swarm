import type { Agent } from "../services/AgentManager.js";
import type { AgentStatsCollector } from "./agentStatsCollector.js";
import type { RunAgentOpts } from "./DiscussionRunnerBase.js";

export interface PostSynthesisCritiqueArgs {
  synthesis: string;
  proposals: ReadonlyArray<{ workerId: string; text: string }>;
  criticAgent: Agent;
  manager: import("../services/AgentManager.js").AgentManager;
  appendSystem: (text: string) => void;
  stopping: boolean;
  runDiscussionAgent: (agent: Agent, prompt: string, opts: RunAgentOpts) => Promise<string>;
  stats: AgentStatsCollector;
  presetName: string;
}

export async function runPostSynthesisCritique(
  args: PostSynthesisCritiqueArgs
): Promise<string> {
  if (args.stopping) return args.synthesis;

  const proposalsSection = args.proposals
    .map((p) => `[${p.workerId}]: ${p.text.slice(0, 500)}`)
    .join("\n\n");

  const prompt = `You are a synthesis critic. Your job is to find gaps, inconsistencies, and weak points in the team's synthesis, then produce a REVISED version that addresses them.

## Team's Proposals
${proposalsSection}

## Current Synthesis
${args.synthesis}

## Your Task
1. Identify the 2-3 most significant gaps or weaknesses in the current synthesis.
2. Produce a revised synthesis that addresses them, incorporating the strongest points from the proposals.
3. Keep the revised synthesis under 400 words.
4. Start your response with the revised synthesis directly — no preamble.

Format:
GAPS: <numbered list of gaps>
REVISED: <revised synthesis>`;

  const response = await args.runDiscussionAgent(args.criticAgent, prompt, {
    runnerName: args.presetName,
    stats: args.stats,
    agentName: "swarm-read",
  });

  if (!response || args.stopping) return args.synthesis;

  const revisedMatch = response.match(/REVISED:\s*([\s\S]+)/);
  if (revisedMatch && revisedMatch[1].trim().length > 50) {
    args.appendSystem("[Post-synthesis critique] Synthesis revised by critic.");
    return revisedMatch[1].trim();
  }

  if (response.trim().length > 50) {
    args.appendSystem("[Post-synthesis critique] Synthesis revised by critic.");
    return response.trim();
  }

  return args.synthesis;
}