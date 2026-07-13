// Research pre-pass: free-form web exploration before JSON-locked contract/todo turns.
// Runs when webTools/plannerTools are enabled so the planner can search and fetch
// before emitting structured JSON.

import type { Agent } from "../../services/AgentManager.js";
import { extractText } from "../extractText.js";
import { resolveToolProfile } from "../toolProfiles.js";
import {
  chatOnceWithStreaming,
  type ChatStreamingSurface,
} from "./promptRunner.js";
import { isPromptHaltError } from "./lifecycleState.js";
import { isResearchRun } from "../researchHelpers.js";
import type { RunConfig } from "../SwarmRunner.js";
import type { PlannerSeed } from "./prompts/planner.js";
import { buildResearchToolsNote } from "./prompts/planner.js";
import { isUsableResearchBrief } from "../researchBrief.js";
import { resolveMaxToolTurnsForPlanningPhase } from "@ollama-swarm/shared/toolProfiles";

export function shouldRunResearchPrePass(cfg: RunConfig, seed: PlannerSeed): boolean {
  if (!seed.webToolsEnabled) return false;
  // Goal pre-pass already ran with web + read tools — skip redundant web research.
  if (seed.goalPrePassWithWebTools) return false;
  if (seed.researchNotes && seed.researchNotes.trim().length > 0) return false;
  const directive = (seed.userDirective ?? "").trim();
  if (directive.length > 0) return true;
  return isResearchRun(cfg);
}

export async function runResearchPrePass(
  planner: Agent,
  seed: PlannerSeed,
  cfg: RunConfig,
  appendSystem: (text: string) => void,
  opts: {
    signal?: AbortSignal;
    /** @deprecated Prefer streaming surface — wires dock + activity labels. */
    onStatusChange?: (status: "thinking" | "ready") => void;
    streaming?: ChatStreamingSurface;
    onTool?: (info: { tool: string; ok: boolean; preview: string }) => void;
    /** When set, raw model output is appended as an agent bubble (tool trace attaches there). */
    onAgentOutput?: (text: string) => void;
  } = {},
): Promise<string | undefined> {
  if (!shouldRunResearchPrePass(cfg, seed)) return undefined;

  const directive = (seed.userDirective ?? "").trim();
  const topic = directive.length > 0
    ? directive.slice(0, 500)
    : "the repository goals and any external context needed to plan this run";

  appendSystem("Research pre-pass: gathering web sources before contract derivation…");
  const toolsNote = buildResearchToolsNote(true);
  const prompt = [
    "You are a research planner preparing evidence BEFORE a structured planning pass.",
    "Use web_search and web_fetch to gather verifiable, citable information.",
    "",
    toolsNote,
    "",
    `Topic / directive: ${topic}`,
    `Repository: ${seed.repoUrl}`,
    `Clone path: ${seed.clonePath}`,
    "",
    "Deliver a concise research brief (plain prose, NOT JSON) with:",
    "- 5-10 bullet findings with source URLs",
    "- Key data points, methods, or definitions discovered",
    "- Gaps, contradictions, or open questions",
    "- Suggested file targets in the repo for documenting findings",
    "",
    "Cite every claim with at least one URL. Prefer primary sources and recent papers (2020+).",
    "Use web_search/web_fetch for external facts when helpful.",
  ].join("\n");

  if (opts.signal?.aborted) return undefined;
  const profile = resolveToolProfile("planner", cfg);
  const chatOpts = {
    agentName: profile,
    promptText: prompt,
    signal: opts.signal,
    clonePath: seed.clonePath,
    runId: cfg.runId,
    webToolsConfig: cfg,
    mcpServers: cfg.mcpServers,
    ...(opts.onTool ? { onTool: opts.onTool } : {}),
  };
  try {
    const res = opts.streaming
      ? await chatOnceWithStreaming(planner, opts.streaming, chatOpts)
      : await (async () => {
          opts.onStatusChange?.("thinking");
          try {
            const { chatOnce } = await import("../chatOnce.js");
            return chatOnce(planner, {
              ...chatOpts,
              manager: opts.streaming?.manager,
              activity: { kind: "planning", label: "research pre-pass" },
            });
          } finally {
            opts.onStatusChange?.("ready");
          }
        })();
    const text = extractText(res)?.trim() ?? "";
    if (!isUsableResearchBrief(text)) {
      appendSystem(
        "Research pre-pass: no usable brief (need bullet findings with URLs, not intent-only text); continuing without web notes.",
      );
      return undefined;
    }
    const capped = text.length > 12_000 ? `${text.slice(0, 12_000)}…` : text;
    opts.onAgentOutput?.(capped);
    appendSystem(`Research pre-pass: captured ${capped.length} chars of web research notes.`);
    return capped;
  } catch (err) {
    const stopping = () => opts.streaming?.abort?.isStopping?.() ?? false;
    const draining = () => opts.streaming?.abort?.isDraining?.() ?? false;
    if (opts.signal?.aborted || isPromptHaltError(err, stopping, draining)) {
      throw err;
    }
    appendSystem(
      `Research pre-pass failed (${err instanceof Error ? err.message : String(err)}); continuing without web notes.`,
    );
    return undefined;
  }
}