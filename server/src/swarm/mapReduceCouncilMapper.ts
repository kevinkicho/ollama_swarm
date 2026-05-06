import type { Agent } from "../services/AgentManager.js";
import type { TranscriptEntry } from "../types.js";
import type { AgentStatsCollector } from "./agentStatsCollector.js";
import type { RunAgentOpts } from "./DiscussionRunnerBase.js";
import {
  buildCouncilMapperDraftPrompt,
  buildCouncilMapperSynthesisPrompt,
} from "./mapReducePromptHelpers.js";

export interface CouncilMapperResult {
  synthesis: string;
  drafts: string[];
  convergence: "high" | "medium" | "low";
}

export async function runCouncilMapperSlice(args: {
  agents: Agent[];
  slice: readonly string[];
  seedTranscript: readonly TranscriptEntry[];
  userDirective?: string;
  runDiscussionAgent: (agent: Agent, prompt: string, opts: RunAgentOpts) => Promise<string>;
  stats: AgentStatsCollector;
  appendSystem: (text: string) => void;
  presetName: string;
  stopping: boolean;
  rounds?: number;
}): Promise<CouncilMapperResult> {
  const {
    agents,
    slice,
    seedTranscript,
    userDirective,
    runDiscussionAgent,
    stats,
    appendSystem,
    presetName,
    stopping,
    rounds = 2,
  } = args;

  if (stopping || agents.length === 0) {
    return { synthesis: "", drafts: [], convergence: "low" };
  }

  const clampedRounds = Math.min(Math.max(rounds, 2), 3);

  // Round 1 (Draft): Each agent drafts independently
  const draftPrompt = buildCouncilMapperDraftPrompt(slice, userDirective, seedTranscript);
  const draftSettled = await Promise.allSettled(
    agents.map((agent) =>
      runDiscussionAgent(agent, draftPrompt, {
        runnerName: "map-reduce-council",
        agentName: "swarm-read",
        stats,
      }),
    ),
  );
  const drafts: string[] = draftSettled
    .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((t) => t.length > 0);

  if (drafts.length === 0) {
    appendSystem(`[council-mapper] all draft prompts failed for slice ${slice.join(", ")}`);
    return { synthesis: "", drafts: [], convergence: "low" };
  }

  // Round 2 (Revise): Each agent sees all drafts and revises
  const revisePrompt = [
    "You now see all teammates' drafts for your file slice. Revise your analysis incorporating the best points.",
    "",
    "All drafts:",
    ...drafts.map((d, i) => `Agent ${i + 1}: ${d}`),
    "",
    "Produce your REVISED analysis in under 250 words.",
  ].join("\n");

  const reviseSettled = await Promise.allSettled(
    agents.map((agent) =>
      runDiscussionAgent(agent, revisePrompt, {
        runnerName: "map-reduce-council",
        agentName: "swarm-read",
        stats,
      }),
    ),
  );
  const revised: string[] = reviseSettled
    .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((t) => t.length > 0);

  if (revised.length === 0) {
    appendSystem(`[council-mapper] all revise prompts failed for slice ${slice.join(", ")}`);
    return { synthesis: drafts[0] ?? "", drafts, convergence: "low" };
  }

  // Optional Round 3: one more revision pass (only when rounds=3)
  let finalRevised = revised;
  if (clampedRounds >= 3) {
    const refinePrompt = [
      "You now see revised analyses from all teammates for your file slice. Refine your analysis one more time, resolving any remaining disagreements or gaps.",
      "",
      "Revised analyses:",
      ...revised.map((d, i) => `Agent ${i + 1}: ${d}`),
      "",
      "Produce your FINAL refined analysis in under 250 words.",
    ].join("\n");

    const refineSettled = await Promise.allSettled(
      agents.map((agent) =>
        runDiscussionAgent(agent, refinePrompt, {
          runnerName: "map-reduce-council",
          agentName: "swarm-read",
          stats,
        }),
      ),
    );
    const refined: string[] = refineSettled
      .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")
      .map((r) => r.value)
      .filter((t) => t.length > 0);

    if (refined.length > 0) {
      finalRevised = refined;
    }
  }

  // Synthesis: First agent synthesizes all revised drafts
  const synthesisAgent = agents[0]!;
  const synthPrompt = buildCouncilMapperSynthesisPrompt(finalRevised);
  let synthesis: string;
  try {
    synthesis = await runDiscussionAgent(synthesisAgent, synthPrompt, {
      runnerName: "map-reduce-council",
      agentName: "swarm-read",
      stats,
    });
  } catch {
    // Fall back to longest revised draft
    synthesis = finalRevised.reduce((a, b) => (a.length >= b.length ? a : b), "");
  }

  // Estimate convergence: lower unique-ratio = more overlap = higher convergence
  const allWords = finalRevised.join(" ").toLowerCase().split(/\s+/);
  const uniqueWords = new Set(allWords);
  const overlap = allWords.length > 0 ? uniqueWords.size / allWords.length : 1;
  const convergence: "high" | "medium" | "low" =
    overlap < 0.4 ? "high" : overlap < 0.6 ? "medium" : "low";

  appendSystem(
    `[council-mapper] slice convergence: ${convergence} (unique ratio ${overlap.toFixed(2)})`,
  );

  return { synthesis, drafts, convergence };
}