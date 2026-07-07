// Research pre-pass: free-form web exploration before JSON-locked contract/todo turns.
// Runs when webTools/plannerTools are enabled so the planner can search and fetch
// before emitting structured JSON.

import type { Agent } from "../../services/AgentManager.js";
import { extractText } from "../extractText.js";
import { chatOnce } from "../chatOnce.js";
import { resolveToolProfile } from "../toolProfiles.js";
import { isResearchRun } from "../researchHelpers.js";
import type { RunConfig } from "../SwarmRunner.js";
import type { PlannerSeed } from "./prompts/planner.js";
import { buildResearchToolsNote } from "./prompts/planner.js";
import { makeWebToolHandler } from "../toolCallTranscript.js";

export function shouldRunResearchPrePass(cfg: RunConfig, seed: PlannerSeed): boolean {
  if (!seed.webToolsEnabled) return false;
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
    onStatusChange?: (status: "thinking" | "ready") => void;
    onTool?: (info: { tool: string; ok: boolean; preview: string }) => void;
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
  ].join("\n");

  if (opts.signal?.aborted) return undefined;
  opts.onStatusChange?.("thinking");
  const profile = resolveToolProfile("planner", cfg);
  try {
    const res = await chatOnce(planner, {
      agentName: profile,
      promptText: prompt,
      signal: opts.signal,
      clonePath: seed.clonePath,
      runId: cfg.runId,
      ...(opts.onTool ? { onTool: opts.onTool } : {}),
    });
    const text = extractText(res)?.trim();
    if (!text || text.length < 80) {
      appendSystem("Research pre-pass: no usable brief returned; continuing without web notes.");
      return undefined;
    }
    const capped = text.length > 12_000 ? `${text.slice(0, 12_000)}…` : text;
    appendSystem(`Research pre-pass: captured ${capped.length} chars of web research notes.`);
    return capped;
  } catch (err) {
    appendSystem(
      `Research pre-pass failed (${err instanceof Error ? err.message : String(err)}); continuing without web notes.`,
    );
    return undefined;
  } finally {
    opts.onStatusChange?.("ready");
  }
}