import type { Agent, AgentManager } from "../../services/AgentManager.js";
import { chatOnce } from "../chatOnce.js";
import type { ToolFailureRecord } from "@ollama-swarm/shared/swarmControl/types";
import { toolFailureFingerprint } from "@ollama-swarm/shared/swarmControl/toolFailureTrack";

export const TOOL_COACH_THRESHOLD = 3;
export const TOOL_COACH_MAX_CALLS_PER_RUN = 12;

export interface ToolCoachDeps {
  agent: Agent;
  clonePath?: string;
  runId?: string;
  priorPatterns?: string[];
  manager?: AgentManager;
}

export async function runToolFailureCoach(
  record: ToolFailureRecord,
  preview: string,
  deps: ToolCoachDeps,
): Promise<string | null> {
  const fp = toolFailureFingerprint(record.tool, record.error);
  const prompt = [
    "You are a swarm TOOL COACH. An agent hit the same tool failure repeatedly.",
    "Give ONE short, actionable hint (max 3 sentences) the agent should follow on the next turn.",
    "Prefer alternative tools (read/grep/glob) over repeating the failing command.",
    "Do not write code — only strategy.",
    "",
    `tool=${record.tool}`,
    `failures=${record.count}`,
    `error=${record.error}`,
    preview ? `preview=${preview.slice(0, 300)}` : "",
    `fingerprint=${fp}`,
    deps.priorPatterns?.length
      ? `\npriorRunPatterns:\n${deps.priorPatterns.slice(0, 6).map((p) => `  - ${p}`).join("\n")}`
      : "",
  ].join("\n");

  try {
    const res = await chatOnce(deps.agent, {
      agentName: "swarm-read",
      promptText: prompt,
      clonePath: deps.clonePath,
      runId: deps.runId,
      manager: deps.manager,
      activity: { kind: "control", label: "tool coach" },
    });
    const hint =
      (res as { data?: { parts?: Array<{ text?: string }> } })?.data?.parts?.[0]?.text?.trim() ?? "";
    return hint.length > 0 ? hint.slice(0, 500) : null;
  } catch {
    return null;
  }
}