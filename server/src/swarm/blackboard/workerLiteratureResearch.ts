/**
 * Literature pre-pass for workers (web_search/web_fetch before hunk emit).
 * Extracted from workerRunner.ts.
 */

import type { Agent } from "../../services/AgentManager.js";
import type { AgentManager } from "../../services/AgentManager.js";
import type { AgentState, TranscriptEntry } from "../../types.js";
import type { RunConfig } from "../SwarmRunner.js";
import { extractText } from "../extractText.js";
import { isWebToolsEnabled } from "../toolProfiles.js";
import { makeBufferedToolHandler, type ToolTraceEntry } from "../toolCallTranscript.js";
import { isLiteratureTodo } from "./prompts/worker.js";
import { buildResearchToolsNote } from "./prompts/planner.js";
import { resolveBlackboardPromptExtras } from "./blackboardPromptContext.js";
import { chatOnceWithStreaming, type ChatStreamingSurface } from "./promptRunner.js";
import { isUsableResearchBrief } from "../researchBrief.js";
import { localCatalogNotesOnResearchFail } from "../research/localCatalogIndex.js";
import { isPromptHaltError } from "./lifecycleState.js";
import {
  LITERATURE_RESEARCH_NUDGE_MESSAGE,
  LITERATURE_RESEARCH_NUDGE_TURN,
  LITERATURE_RESEARCH_PROFILE,
  LITERATURE_RESEARCH_TOOLS,
  EXPLORE_MAX_LITERATURE_TOOL_TURNS,
} from "@ollama-swarm/shared/toolProfiles";

/** Minimal ctx surface for literature research. */
export interface LiteratureResearchCtx {
  getActive: () => RunConfig | undefined;
  getAmendments?: () => Array<{ ts: number; text: string }>;
  getTranscript: () => readonly TranscriptEntry[];
  getManager: () => AgentManager;
  emitAgentState: (s: AgentState) => void;
  getActiveAborts: () => Set<AbortController>;
  isStopping: () => boolean;
  isDraining: () => boolean;
  appendAgent: (agent: Agent, text: string) => void;
  appendSystem: (msg: string) => void;
  pendingToolTraceByAgent: Map<string, ToolTraceEntry[]>;
}

export async function runWorkerLiteratureResearch(
  ctx: LiteratureResearchCtx,
  agent: Agent,
  todo: { description: string; expectedFiles: string[] },
  clonePath: string,
): Promise<string | undefined> {
  const cfg = ctx.getActive();
  if (!cfg || !isWebToolsEnabled(cfg) || !isLiteratureTodo(todo.description)) {
    return undefined;
  }
  const profile = LITERATURE_RESEARCH_PROFILE;
  const litExtras = resolveBlackboardPromptExtras({
    active: cfg,
    getAmendments: ctx.getAmendments,
    transcript: ctx.getTranscript(),
    forAgentId: agent.id,
  });
  const litDirective = litExtras.effectiveDirective ?? cfg.userDirective;
  const prompt = [
    "You are a research worker gathering sources BEFORE writing file edits.",
    buildResearchToolsNote(true),
    "",
    `TODO: ${todo.description}`,
    `Target files: ${todo.expectedFiles.join(", ")}`,
    litDirective ? `User directive: ${litDirective}` : "",
    "",
    "Use web_search and web_fetch to gather citable findings. Output plain prose with bullet points and URLs.",
    "Do NOT emit JSON hunks in this phase.",
  ].filter(Boolean).join("\n");

  const chatOpts = {
    agentName: profile,
    promptText: prompt,
    clonePath,
    webToolsConfig: cfg,
    runId: cfg.runId,
    mcpServers: cfg.mcpServers,
    maxToolTurns: EXPLORE_MAX_LITERATURE_TOOL_TURNS,
    toolsOverride: [...LITERATURE_RESEARCH_TOOLS],
    toolLoopNudge: {
      atTurn: LITERATURE_RESEARCH_NUDGE_TURN,
      message: LITERATURE_RESEARCH_NUDGE_MESSAGE,
    },
    onTool: makeBufferedToolHandler(ctx.pendingToolTraceByAgent, agent.id),
  };
  const surface: ChatStreamingSurface = {
    manager: ctx.getManager(),
    emitAgentState: (s) => ctx.emitAgentState(s),
    activity: { kind: "worker", label: "literature research" },
    abort: {
      activeAborts: ctx.getActiveAborts(),
      isStopping: ctx.isStopping,
      isDraining: ctx.isDraining,
    },
  };
  try {
    const res = await chatOnceWithStreaming(agent, surface, chatOpts);
    const text = extractText(res)?.trim() ?? "";
    if (isUsableResearchBrief(text)) {
      const capped = text.length > 8000 ? `${text.slice(0, 8000)}…` : text;
      ctx.appendAgent(agent, capped);
      return capped;
    }
    ctx.appendSystem(
      `[${agent.id}] Literature research: no usable brief — trying local endpoint catalog.`,
    );
  } catch (err) {
    if (isPromptHaltError(err, ctx.isStopping, ctx.isDraining)) return undefined;
    const msg = err instanceof Error ? err.message : String(err);
    ctx.appendSystem(`[${agent.id}] Literature research failed: ${msg}`);
  }

  // Hard search fail / unusable brief: offline catalog grounding (shared with council).
  const localNotes = localCatalogNotesOnResearchFail(todo.description, clonePath);
  if (localNotes) {
    ctx.appendSystem(
      `[${agent.id}] Local catalog: injected ${localNotes.length} chars of endpoint notes (literature fail path).`,
    );
    return localNotes;
  }
  return undefined;
}
