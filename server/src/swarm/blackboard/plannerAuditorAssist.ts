// Auditor JSON salvage when planner contract/todos emit fails rule-based parse.
// Replaces the retired prose-only diagnostic (agent-6 "Root Cause" essays).

import type { Agent } from "../../services/AgentManager.js";
import type { ProfileName } from "../../tools/ToolDispatcher.js";
import { runParseSalvage } from "./parseSalvage.js";

export interface PlannerParseSalvageInput {
  kind: "contract" | "planner-todos";
  parseError: string;
  responseExcerpt: string;
  attempt: number;
  jsonSchema: Record<string, unknown>;
}

export async function runPlannerAuditorSalvage(
  auditor: Agent | undefined,
  deps: {
    getStopping: () => boolean;
    appendSystem: (msg: string) => void;
    appendAgent: (
      agent: Agent,
      text: string,
      options?: { assistKind?: "auditor-salvage" },
    ) => void;
    findingsPost: (entry: { agentId: string; text: string; createdAt: number }) => void;
    promptPlannerSafely: (
      agent: Agent,
      promptText: string,
      agentName?: ProfileName,
      ollamaFormat?: "json" | Record<string, unknown>,
    ) => Promise<{ response: string; agentUsed: Agent }>;
    getActive: () => { dedicatedAuditor?: boolean } | undefined;
  },
  input: PlannerParseSalvageInput,
): Promise<string | null> {
  if (!auditor || deps.getStopping()) return null;
  if (!deps.getActive()?.dedicatedAuditor) return null;

  const salvage = await runParseSalvage(
    auditor,
    {
      getStopping: deps.getStopping,
      appendSystem: deps.appendSystem,
      appendAgent: deps.appendAgent,
      promptPlannerSafely: deps.promptPlannerSafely,
      getActive: deps.getActive,
      jsonSchema: input.jsonSchema,
    },
    {
      kind: input.kind,
      parseError: input.parseError,
      rawOutput: input.responseExcerpt,
      attempt: input.attempt,
    },
  );

  if (!salvage) {
    deps.findingsPost({
      agentId: auditor.id,
      text: `[auditor→planner] ${input.kind} salvage failed (attempt ${input.attempt}): ${input.parseError}`,
      createdAt: Date.now(),
    });
    return null;
  }

  return salvage.json;
}