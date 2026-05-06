import type { TranscriptEntry, TranscriptEntrySummary } from "../types.js";
import type { Agent } from "../services/AgentManager.js";
import type { AgentStatsCollector } from "./agentStatsCollector.js";
import type { RunAgentOpts } from "./DiscussionRunnerBase.js";

export async function maybeRunPostRoundCritique(args: {
  agents: Agent[];
  round: number;
  totalRounds: number;
  transcript: readonly TranscriptEntry[];
  userDirective?: string;
  enabled: boolean;
  runDiscussionAgent: (agent: Agent, prompt: string, opts: RunAgentOpts) => Promise<string>;
  stats: AgentStatsCollector;
  appendSystem: (text: string, summary?: TranscriptEntrySummary) => void;
  presetName: string;
  stopping: boolean;
}): Promise<void> {
  if (!args.enabled || args.round < 1 || args.stopping) {
    return;
  }

  const roster = args.stats.rosterSnapshot();
  if (roster.length === 0) {
    return;
  }

  const agentWithFewestTurns = roster.reduce<{
    id: string;
    index: number;
    turns: number;
  } | null>((best, entry) => {
    const turns = (args.stats as unknown as { buildPerAgentStats(): { agentId: string; turnsTaken: number }[] })
      .buildPerAgentStats()
      .find((s) => s.agentId === entry.id)?.turnsTaken ?? 0;
    if (best === null || turns < best.turns) {
      return { id: entry.id, index: entry.index, turns };
    }
    return best;
  }, null);

  if (!agentWithFewestTurns) {
    return;
  }

  const critic = args.agents.find((a) => a.id === agentWithFewestTurns.id);
  if (!critic) {
    return;
  }

  const recentEntries = args.transcript
    .filter((e) => e.role === "agent")
    .slice(-8);

  const entrySummaries = recentEntries
    .map((e) => `[${e.agentId}] ${e.text.slice(0, 300)}`)
    .join("\n");

  const directiveLine = args.userDirective
    ? `\n\nUser directive: ${args.userDirective}`
    : "";

  const prompt = `You are the CRITIC this round. Review the team's recent discussion. What's missing? What's wrong? What should the team focus on next? Keep your response under 150 words.

Recent discussion:\n${entrySummaries}${directiveLine}`;

  const critique = await args.runDiscussionAgent(critic, prompt, {
    runnerName: args.presetName,
    agentName: "swarm-read",
    stats: args.stats,
  });

  const trimmed = critique.trim();
  if (trimmed) {
    args.appendSystem(`[Round ${args.round} Critique] ${trimmed}`);
  }
}