// Short multi-agent research pass each council cycle (when web tools on).
// Complements per-todo literature research — collective scan of directive gaps.

import type { Agent, AgentManager } from "../services/AgentManager.js";
import type { RunConfig } from "./SwarmRunner.js";
import { chatOnce } from "./chatOnce.js";
import { extractText } from "./extractText.js";
import { isWebToolsEnabled } from "./toolProfiles.js";
import {
  EXPLORE_MAX_LITERATURE_TOOL_TURNS,
  LITERATURE_RESEARCH_NUDGE_MESSAGE,
  LITERATURE_RESEARCH_NUDGE_TURN,
  LITERATURE_RESEARCH_PROFILE,
  LITERATURE_RESEARCH_TOOLS,
} from "@ollama-swarm/shared/toolProfiles";
import { buildResearchToolsNote } from "./blackboard/prompts/planner.js";
import { isUsableResearchBrief } from "./researchBrief.js";
import { burstSpacingForModels, staggerStart } from "./staggerStart.js";

export async function runCouncilResearchStandup(opts: {
  manager: AgentManager;
  cfg: RunConfig;
  cycle: number;
  appendSystem: (msg: string, summary?: unknown) => void;
  closingRequested: () => boolean;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  const { manager, cfg, cycle, appendSystem, closingRequested, signal } = opts;
  if (!isWebToolsEnabled(cfg)) return undefined;
  if (closingRequested() || signal?.aborted) return undefined;

  const agents = manager.list().slice(0, Math.min(3, manager.list().length));
  if (agents.length === 0) return undefined;

  appendSystem(`Research standup — cycle ${cycle} (${agents.length} agent(s))`, {
    kind: "council_stage",
    cycle,
    stage: "research",
    detail: `${agents.length} agent(s)`,
  });

  const notes: string[] = [];
  await staggerStart(
    agents,
    async (agent: Agent) => {
      if (closingRequested() || signal?.aborted) return;
      manager.markStatus(agent.id, "thinking", {
        activityKind: "council",
        activityLabel: "research standup",
        thinkingSince: Date.now(),
      } as any);
      try {
        const prompt = [
          "You are part of a council research standup (short, shared scan).",
          buildResearchToolsNote(true),
          "",
          cfg.userDirective ? `User directive: ${cfg.userDirective}` : "User directive: (none)",
          "",
          "Use web_search and/or web_fetch to find 2–5 citable facts that advance the directive.",
          "Prefer official papers, docs, and primary sources. Output plain prose bullets with URLs.",
          "Do NOT emit JSON hunks. Keep under ~400 words.",
        ].join("\n");
        const res = await chatOnce(agent, {
          agentName: LITERATURE_RESEARCH_PROFILE,
          promptText: prompt,
          clonePath: cfg.localPath,
          webToolsConfig: cfg,
          runId: cfg.runId,
          mcpServers: cfg.mcpServers,
          signal,
          manager: manager as any,
          activity: { kind: "council", label: "research standup" },
          maxToolTurns: Math.min(6, EXPLORE_MAX_LITERATURE_TOOL_TURNS),
          toolsOverride: [...LITERATURE_RESEARCH_TOOLS],
          toolLoopNudge: {
            atTurn: LITERATURE_RESEARCH_NUDGE_TURN,
            message: LITERATURE_RESEARCH_NUDGE_MESSAGE,
          },
        });
        const text = extractText(res)?.trim() ?? "";
        if (isUsableResearchBrief(text) || text.length >= 120) {
          const capped = text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
          notes.push(`[agent-${agent.index}]\n${capped}`);
          appendSystem(
            `[${agent.id}] Research standup: captured ${capped.length} chars.`,
          );
        } else if (text.length > 0) {
          appendSystem(
            `[${agent.id}] Research standup: output too thin (${text.length} chars) — skipped.`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendSystem(`[${agent.id}] Research standup failed: ${msg}`);
      } finally {
        manager.markStatus(agent.id, "ready", { lastMessageAt: Date.now() } as any);
      }
    },
    burstSpacingForModels(agents),
  );

  if (notes.length === 0) return undefined;
  return notes.join("\n\n");
}
