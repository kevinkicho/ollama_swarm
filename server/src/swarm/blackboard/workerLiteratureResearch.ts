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
import {
  isResearchBlackout,
  noteCatalogInject,
  noteResearchAttempt,
  noteResearchFailure,
  noteResearchSuccess,
  getResearchBlackoutReason,
} from "../research/researchBudget.js";
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
  const runId = cfg.runId;
  const profile = LITERATURE_RESEARCH_PROFILE;
  const litExtras = resolveBlackboardPromptExtras({
    active: cfg,
    getAmendments: ctx.getAmendments,
    transcript: ctx.getTranscript(),
    forAgentId: agent.id,
  });
  const litDirective = litExtras.effectiveDirective ?? cfg.userDirective;
  // RR-C local-first: inject catalog before web when offline docs hit.
  const localFirst = localCatalogNotesOnResearchFail(todo.description, clonePath);
  if (localFirst && localFirst.length >= 200) {
    noteCatalogInject(runId);
    ctx.appendSystem(
      `[${agent.id}] Local catalog (local-first): injected ${localFirst.length} chars — skipping web literature pre-pass.`,
    );
    return localFirst.length > 8000 ? `${localFirst.slice(0, 8000)}…` : localFirst;
  }

  // RR-C: shared blackout with council (process/run-scoped budget).
  if (isResearchBlackout(runId)) {
    const why = getResearchBlackoutReason(runId) ?? "budget/blackout";
    ctx.appendSystem(
      `[${agent.id}] Literature research skipped (research blackout: ${why.slice(0, 80)}) — local tools only.`,
    );
    if (localFirst) {
      noteCatalogInject(runId);
      return localFirst.length > 8000 ? `${localFirst.slice(0, 8000)}…` : localFirst;
    }
    const notes = localCatalogNotesOnResearchFail(todo.description, clonePath);
    if (notes) {
      noteCatalogInject(runId);
      return notes;
    }
    return undefined;
  }

  const prompt = [
    "You are a research worker gathering sources BEFORE writing file edits.",
    buildResearchToolsNote(true),
    "",
    `TODO: ${todo.description}`,
    `Target files: ${todo.expectedFiles.join(", ")}`,
    litDirective ? `User directive: ${litDirective}` : "",
    localFirst
      ? `\nLOCAL CATALOG NOTES (also try read/grep on clone docs):\n${localFirst.slice(0, 3000)}`
      : "",
    "",
    "Prefer local clone docs (API_ENDPOINTS, GOVERNMENT_API_CATALOG, PANELS) via read/grep when available.",
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
    // RR-C: allow read/grep/list so local-first is executable.
    toolsOverride: [...LITERATURE_RESEARCH_TOOLS] as const,
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
  noteResearchAttempt(runId);
  try {
    const res = await chatOnceWithStreaming(agent, surface, chatOpts);
    const text = extractText(res)?.trim() ?? "";
    if (isUsableResearchBrief(text)) {
      const capped = text.length > 8000 ? `${text.slice(0, 8000)}…` : text;
      ctx.appendAgent(agent, capped);
      noteResearchSuccess(runId);
      return capped;
    }
    const { blackoutJustActivated } = noteResearchFailure("unusable brief", runId);
    ctx.appendSystem(
      `[${agent.id}] Literature research: no usable brief — trying local endpoint catalog.`,
    );
    if (blackoutJustActivated) {
      ctx.appendSystem(
        `[research] Run-level literature blackout activated — further web literature pre-passes skipped.`,
      );
    }
  } catch (err) {
    if (isPromptHaltError(err, ctx.isStopping, ctx.isDraining)) return undefined;
    const msg = err instanceof Error ? err.message : String(err);
    const { blackoutJustActivated } = noteResearchFailure(msg, runId);
    ctx.appendSystem(`[${agent.id}] Literature research failed: ${msg}`);
    if (blackoutJustActivated) {
      ctx.appendSystem(
        `[research] Run-level literature blackout activated — further web literature pre-passes skipped.`,
      );
    }
  }

  // Hard search fail / unusable brief: offline catalog grounding (shared with council).
  const localNotes = localFirst || localCatalogNotesOnResearchFail(todo.description, clonePath);
  if (localNotes) {
    noteCatalogInject(runId);
    ctx.appendSystem(
      `[${agent.id}] Local catalog: injected ${localNotes.length} chars of endpoint notes (literature fail path).`,
    );
    return localNotes;
  }
  return undefined;
}
